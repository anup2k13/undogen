"""A Python runtime for undogen: journal every write with the request that undoes it.

It reads the bundle written by ``undogen compile spec.yaml -o undogen.json`` (the
operations and compiled undo plans), so the compiling and verifying stays in one
place and Python agents get the same behaviour as the TypeScript client:

- irreversible and unknown calls are blocked unless approved
- identical irreversible calls are refused a second time (replays)
- before undoing, the state the call produced is re-read; if someone else
  changed it, the undo stops with ConflictError instead of overwriting them
- undo requests carry an Idempotency-Key and If-Match when the API sends ETags
- resources re-created by undo get new ids, which later undos follow
- undoing a create that later writes depend on raises DependencyError (or cascades)
"""

from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Union

Scalar = Union[str, int, float]


class UndogenError(Exception):
    """Base class for undogen errors."""


class IrreversibleOperationError(UndogenError):
    def __init__(self, operation_id: str, plan: dict):
        reasons = "; ".join(plan.get("reasons") or []) or "no inverse"
        super().__init__(
            f"Refusing to run {operation_id}: it is {plan['reversibility']} ({reasons}). "
            "Pass allow_irreversible to approve it explicitly."
        )
        self.operation_id = operation_id
        self.plan = plan


class ReplayBlockedError(IrreversibleOperationError):
    def __init__(self, operation_id: str, plan: dict, previous: dict):
        super().__init__(operation_id, plan)
        self.previous = previous
        self.args = (
            f"Refusing to repeat {operation_id}: an identical irreversible call already ran as "
            f"#{previous['seq']} at {previous['at']}. Approve it with an allow_irreversible function "
            "(it receives replay_of) or set allow_replays.",
        )


class UndoError(UndogenError):
    def __init__(self, message: str, entry: dict, response: Optional[dict] = None):
        super().__init__(message)
        self.entry = entry
        self.response = response


class ConflictError(UndoError):
    """The state an entry produced was changed by someone else; undoing would overwrite their change."""

    def __init__(self, entry: dict, conflicts: List[dict], response: Optional[dict] = None, suffix: str = ""):
        what = "; ".join(f"{c['field']}: expected {json.dumps(c['expected'])}, found {json.dumps(c['actual'])}" for c in conflicts)
        super().__init__(
            f"Undo of #{entry['seq']} ({entry['operationId']}) refused: the state it wrote has changed since ({what}). "
            "Pass force=True to overwrite anyway." + suffix,
            entry,
            response,
        )
        self.conflicts = conflicts


class DependencyError(UndoError):
    def __init__(
        self,
        entry: dict,
        dependents: List[dict],
        others: Union[List[dict], bool, None] = None,
        cascade_refused: bool = False,
        other_sessions: bool = False,  # the earlier name of cascade_refused
    ):
        # Also accepts the earlier (entry, dependents, other_sessions: bool) form.
        if isinstance(others, bool):
            cascade_refused, others = cascade_refused or others, None
        cascade_refused = cascade_refused or other_sessions
        def names(ds: List[dict], with_session: bool) -> str:
            return ", ".join(f"#{d['seq']} {d['operationId']}" + (f" (session {d.get('session')})" if with_session else "") for d in ds)

        head = f"Undo of #{entry['seq']} ({entry['operationId']}) would orphan later writes"
        if cascade_refused:
            message = f"{head} from other sessions: {names(dependents, True)}. Cascade doesn't touch other sessions: undo those sessions' writes first."
        elif others:
            message = f"{head} that use it: {names(dependents, False)}. Undo those first. (A cascade would stop at writes from other sessions: {names(others, True)}.)"
        else:
            message = f"{head} that use it: {names(dependents, False)}. Undo those first, or pass cascade=True."
        super().__init__(message, entry)
        self.dependents = dependents


class MemoryJournalStore:
    def __init__(self) -> None:
        self._entries: Dict[int, dict] = {}

    def load(self) -> List[dict]:
        return [copy.deepcopy(e) for e in sorted(self._entries.values(), key=lambda e: e["seq"])]

    def save(self, entry: dict) -> None:
        self._entries[entry["seq"]] = copy.deepcopy(entry)


class FileJournalStore:
    """JSON Lines, compatible with the TypeScript FileJournalStore and ``undogen undo --journal``."""

    def __init__(self, path: str) -> None:
        self.path = path

    def load(self) -> List[dict]:
        if not os.path.exists(self.path):
            return []
        by_seq: Dict[int, dict] = {}
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    e = json.loads(line)
                    by_seq[e["seq"]] = e
        return [by_seq[k] for k in sorted(by_seq)]

    def save(self, entry: dict) -> None:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        # Entries hold request and response bodies: create the file readable by its owner only.
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")

    def compact(self) -> dict:
        """Rewrite the file with only the latest version of each entry, atomically (temp file + rename)."""
        if not os.path.exists(self.path):
            return {"before": 0, "after": 0}
        with open(self.path, encoding="utf-8") as f:
            before = sum(1 for line in f if line.strip())
        entries = self.load()
        tmp = f"{self.path}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(e, separators=(",", ":")) + "\n" for e in entries)
        os.replace(tmp, self.path)
        return {"before": before, "after": len(entries)}


@dataclass
class OutgoingRequest:
    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]


@dataclass
class Bundle:
    """Operations and compiled plans, from ``undogen compile``."""

    operations: Dict[str, dict]
    plans: Dict[str, dict]
    spec: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: str) -> "Bundle":
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    @classmethod
    def from_dict(cls, data: dict) -> "Bundle":
        if not str(data.get("format", "")).startswith("undogen-bundle/"):
            raise ValueError("Not an undogen bundle: run `undogen compile spec.yaml -o undogen.json`")
        return cls(
            operations={o["id"]: o for o in data["operations"]},
            plans={p["operationId"]: p for p in data["plans"]},
            spec=data.get("spec", {}),
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _stable(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def _js_number(f: float) -> str:
    """A number as JavaScript's Number.prototype.toString writes it (both runtimes use the shortest round-trip digits)."""
    if f != f:
        return "NaN"
    if f in (float("inf"), float("-inf")):
        return "Infinity" if f > 0 else "-Infinity"
    if f == 0:
        return "0"
    t = Decimal(repr(abs(f))).as_tuple()
    raw = "".join(str(d) for d in t.digits)
    digits = raw.rstrip("0") or "0"
    k = len(digits)
    n = k + int(t.exponent) + (len(raw) - len(digits))  # value = 0.<digits> * 10**n
    sign = "-" if f < 0 else ""
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"


def _js_str(v: Any) -> str:
    """str() as JavaScript's String() would write it, so hashes and id maps agree across runtimes (12345.0 -> "12345")."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    if isinstance(v, float):
        return _js_number(v)
    # Integers stay exact (JavaScript would round those above 2**53; exact ids matter more than matching that).
    return str(v)


def _id_forms(v: Any) -> List[str]:
    """
    The spellings of an id that journals may hold, all checked when matching: the JavaScript form and the str() form
    earlier Python versions wrote. Integers above 2**53 stay exact (the TypeScript runtime rounds them, so
    dependencies on such ids aren't seen across runtimes). Values too large to write at all have none.
    """
    forms: List[str] = []
    try:
        forms.append(_js_str(v))
        if isinstance(v, float):
            forms.append(str(v))
    except (ValueError, OverflowError):
        pass  # e.g. an integer over Python's 4300-digit str() limit
    return list(dict.fromkeys(forms))


def _ts_rounded(v: Any) -> Optional[str]:
    """How the TypeScript runtime spells an integer above 2**53 (as the nearest double). Only a fallback for reading
    keys it wrote: neighbouring ids share it, so it is never used to match or written."""
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 2**53:
        try:
            return _js_number(float(v))
        except OverflowError:
            return None
    return None


def _id_like(v: str) -> bool:
    """A value that looks like an identifier rather than a word: 8+ characters with a digit, dash or underscore."""
    return len(v) >= 8 and any(c in "0123456789-_" for c in v)


def _ref_hash(value: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}\u0000{value}".encode()).hexdigest()[:32]


def _body_refs(body: Any, salt: str) -> Optional[List[str]]:
    """Hashes of the id-like values (4+ characters) in a body: enough for dependency checks without the body."""
    out: Dict[str, None] = {}

    def walk(v: Any, depth: int) -> None:
        if depth > 3 or v is None or isinstance(v, bool):
            return
        if isinstance(v, (str, int, float)):
            for form in _id_forms(v):
                if len(form) >= 4:
                    out[_ref_hash(form, salt)] = None
        elif isinstance(v, list):
            for x in v:
                walk(x, depth + 1)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x, depth + 1)

    walk(body, 0)
    return list(out) or None


def _body_mentions(body: Any, ids: set, depth: int = 0) -> bool:
    if depth > 3 or body is None or isinstance(body, bool):
        return False
    if isinstance(body, (str, int, float)):
        return any(f in ids for f in _id_forms(body))
    if isinstance(body, list):
        return any(_body_mentions(x, ids, depth + 1) for x in body)
    if isinstance(body, dict):
        return any(_body_mentions(x, ids, depth + 1) for x in body.values())
    return False


def get_path(obj: Any, dotted: str) -> Any:
    cur = obj
    for key in dotted.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, list) and key.isdigit():
            cur = cur[int(key)] if int(key) < len(cur) else None
        else:
            return None
    return cur


def fill_path(path: str, params: Dict[str, Any]) -> str:
    out = []
    i = 0
    while i < len(path):
        if path[i] == "{":
            j = path.index("}", i)
            name = path[i + 1 : j]
            if params.get(name) is None:
                raise UndogenError(f'Missing path parameter "{name}" for {path}')
            value = str(params[name])
            # "." and ".." would be collapsed by URL normalization (in proxies and servers), reaching another route.
            if value in ("", ".", ".."):
                raise UndogenError(f'Path parameter "{name}" for {path} must not be {repr(value) if value else "empty"}')
            out.append(urllib.parse.quote(value, safe=""))
            i = j + 1
        else:
            out.append(path[i])
            i += 1
    return "".join(out)


class UndoableClient:
    """Calls an API by operationId and journals every write with its inverse."""

    def __init__(
        self,
        bundle: Union[Bundle, str, dict],
        base_url: str,
        *,
        headers: Union[Dict[str, str], Callable[[], Dict[str, str]], None] = None,
        before_request: Optional[Callable[[OutgoingRequest], None]] = None,
        allow_irreversible: Union[bool, Callable[..., bool]] = False,
        allow_replays: bool = False,
        store: Any = None,
        session: Optional[str] = None,
        check_conflicts: bool = True,
        idempotency_header: Union[str, bool] = "Idempotency-Key",
        retries: int = 2,
        retry_delay: float = 0.25,
        timeout: float = 30.0,
        journal_detail: str = "full",
    ) -> None:
        if isinstance(bundle, str):
            bundle = Bundle.load(bundle)
        elif isinstance(bundle, dict):
            bundle = Bundle.from_dict(bundle)
        self.bundle = bundle
        self.base_url = base_url.rstrip("/")
        self.headers = headers
        self.before_request = before_request
        self.allow_irreversible = allow_irreversible
        self.allow_replays = allow_replays
        self.store = store or MemoryJournalStore()
        self.session = session or uuid.uuid4().hex[:8]
        self.check_conflicts = check_conflicts
        self.idempotency_header = idempotency_header
        self.retries = retries
        self.retry_delay = retry_delay
        self.timeout = timeout
        self.journal_detail = journal_detail
        self.journal: List[dict] = []
        self._id_map: Dict[str, Dict[str, Scalar]] = {}
        loaded = self.store.load()
        if any(e.get("kind") == "tool" for e in loaded):
            raise UndogenError("This journal was written by `undogen wrap` (tool calls, not HTTP requests); undo it with `undogen wrap --journal <file> --undo ... -- <server command>`")
        for entry in loaded:
            self.journal.append(entry)
            for param, mapping in (entry.get("idMap") or {}).items():
                for old, new in mapping.items():
                    self._id_map.setdefault(param, {})[old] = new
        self._seq = max((e["seq"] for e in self.journal), default=0)

    # -- public API ---------------------------------------------------------

    def plan_for(self, operation_id: str) -> Optional[dict]:
        return self.bundle.plans.get(operation_id)

    def call(
        self,
        operation_id: str,
        params: Optional[Dict[str, Scalar]] = None,
        body: Any = None,
        query: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        *,
        approved: bool = False,
    ) -> dict:
        """Call an operation. Writes are journaled; the result has ``status``, ``data``, ``headers`` and ``entry``.

        ``approved=True`` means a human already approved this call (e.g. through the agent
        framework's own approval step), so the irreversible gate and replay guard are skipped.
        """
        op = self.bundle.operations.get(operation_id)
        if op is None:
            raise UndogenError(f"Unknown operation: {operation_id}")
        params = dict(params or {})
        query = dict(query or {})

        if op["method"] == "get":
            return self.request("get", fill_path(op["path"], params), query=query, headers=headers)

        plan = self.bundle.plans.get(operation_id)
        if plan is None:
            raise UndogenError(f"No undo plan for {operation_id}")

        fingerprint = None
        if plan["reversibility"] in ("irreversible", "unknown"):
            # Same JSON as the TypeScript runtime (sorted keys, raw UTF-8), so replays are recognised across runtimes.
            fingerprint = hashlib.sha256(
                _stable_js({"operationId": operation_id, "params": params, "query": query, "body": body}).encode()
            ).hexdigest()[:32]
            replay_of = next((e for e in self.journal if e.get("fingerprint") == fingerprint), None)
            if not approved:
                gate = self.allow_irreversible
                ok = gate(op, plan, {"params": params, "query": query, "body": body}, replay_of) if callable(gate) else bool(gate)
                if not ok:
                    raise IrreversibleOperationError(operation_id, plan)
                if replay_of and not callable(gate) and not self.allow_replays:
                    raise ReplayBlockedError(operation_id, plan, replay_of)

        sources: Dict[str, Any] = {"params": params, "query": query, "request": body}
        before: Any = None
        captured = False
        children = None
        if plan.get("capture"):
            cap = plan["capture"]
            snap = self.request("get", self._resolve_path(cap, sources), query=self._resolve_query(cap, sources))
            if snap["status"] in (404, 410):
                before = None
            elif snap["status"] < 300:
                before = snap["data"] if snap["data"] is not None else {}
            else:
                raise UndogenError(f"Capture before {operation_id} failed: HTTP {snap['status']}")
            captured = True
            if before is not None and plan.get("children"):
                children = self._capture_children(plan["children"], params)

        # Paired actions and toggles: read the state first, so we know what the call changed.
        diff_before = None
        if plan.get("checkMode") and plan.get("check") and self.check_conflicts:
            try:
                diff_before = self.request("get", self._resolve_path(plan["check"], sources), query=self._resolve_query(plan["check"], sources))
            except UndogenError:
                diff_before = None

        path = fill_path(op["path"], params)
        response = self.request(op["method"], path, query=query, headers=headers, body=body, content_type=op.get("requestContentType"))
        if response["status"] >= 400:
            return response

        sources.update({"response": response["data"], "responseHeaders": response["headers"], "before": before})
        template = plan.get("inverseIfMissing") if captured and before is None and plan.get("inverseIfMissing") else plan.get("inverse")
        inverse = None
        inverse_error = None
        if template:
            try:
                inverse = self._resolve_request(template, sources)
            except UndogenError as err:
                inverse_error = str(err)
        elif plan["strategy"] != "no-side-effects":
            inverse_error = "No inverse for this operation"

        self._seq += 1
        entry: Dict[str, Any] = {
            "seq": self._seq,
            "session": self.session,
            "at": _now(),
            "operationId": operation_id,
            "request": {
                "operationId": operation_id,
                "method": op["method"],
                "path": path,
                "pathTemplate": op["path"],
                "params": params,
                "query": query or None,
                "body": body,
                "contentType": op.get("requestContentType"),
            },
            "response": response,
            "plan": {k: plan[k] for k in ("reversibility", "strategy", "confidence")},
            "inverse": inverse,
            "status": "active",
            "undone": False,
        }
        if captured:
            entry["before"] = before
        if children:
            entry["children"] = children
        if inverse_error:
            entry["inverseError"] = inverse_error
        if fingerprint:
            entry["fingerprint"] = fingerprint
        if plan.get("identity"):
            entry["identity"] = plan["identity"]
        if inverse and plan.get("check") and diff_before is not None:
            try:
                after = self.request("get", self._resolve_path(plan["check"], sources), query=self._resolve_query(plan["check"], sources))
                changed = _changed_state(diff_before, after)
                if changed:
                    entry["check"] = {
                        "pathTemplate": plan["check"]["path"],
                        "params": self._resolve_params(plan["check"], sources),
                        "query": self._resolve_query(plan["check"], sources),
                        "expected": changed,
                        "mode": "diff",
                    }
                elif plan.get("checkMode") == "diff-exact":
                    entry["noop"] = True
            except UndogenError:
                pass
        elif inverse and plan.get("check") and not plan.get("checkMode") and self.check_conflicts:
            try:
                only_echoed = inverse["method"] == "delete" or plan["strategy"] == "soft-delete"
                entry["check"] = {
                    "pathTemplate": plan["check"]["path"],
                    "params": self._resolve_params(plan["check"], sources),
                    "query": self._resolve_query(plan["check"], sources),
                    "expected": _expected_state(body, response["data"], only_echoed),
                }
            except UndogenError:
                pass
        if inverse and template and (inverse["method"] == "delete" or plan["strategy"] == "soft-delete"):
            created_by = _created_binding(template)
            if created_by and inverse["params"].get(created_by) is not None:
                entry["created"] = {"param": created_by, "value": inverse["params"][created_by]}
                if template["bindings"][created_by]["from"] == "request":
                    entry["created"]["chosen"] = True
        self.journal.append(entry)
        self._persist(entry)
        return {**response, "entry": entry}

    def dependents_of(self, entry: dict) -> List[dict]:
        created = entry.get("created")
        if not created:
            return []
        param, value = created["param"], created["value"]
        ids = {*_id_forms(value), *_id_forms(self.remap_id(param, value))}
        # In the body too (POST /comments {todoId}), but only for ids that can't be mistaken for small numbers;
        # a name the caller chose only when it looks like an id (PROJ-8f3a2c), not a word ("test", "prod").
        body_ids = {i for i in ids if (_id_like(i) if created.get("chosen") else len(i) >= 4)}
        return [
            e
            for e in self.journal
            if e["seq"] > entry["seq"]
            and e["status"] != "undone"
            and e["plan"]["strategy"] != "no-side-effects"
            and e.get("inverse") is not None
            and (
                any(f in ids for f in _id_forms((e["request"].get("params") or {}).get(param)))
                or (body_ids and _body_mentions(e["request"].get("body"), body_ids))
                or (body_ids and any(_ref_hash(i, e.get("session", "")) in (e["request"].get("bodyRefs") or []) for i in body_ids))
            )
        ]

    def all_dependents_of(self, entry: dict) -> List[dict]:
        """Every later entry that depends on this one, directly or through others (what a cascade would undo)."""
        seen: Dict[int, dict] = {}
        queue = list(self.dependents_of(entry))
        while queue:
            d = queue.pop(0)
            if d["seq"] in seen:
                continue
            seen[d["seq"]] = d
            queue.extend(self.dependents_of(d))
        return sorted(seen.values(), key=lambda e: e["seq"])

    def undo(
        self,
        entry: Union[dict, int, None] = None,
        *,
        force: bool = False,
        cascade: bool = False,
        cascade_within: Optional[str] = None,
        _dependents_checked: bool = False,
    ) -> dict:
        """Undo one entry (or seq). Default: the most recent entry not yet undone."""
        if isinstance(entry, int):
            target = next((e for e in self.journal if e["seq"] == entry), None)
            if target is None:
                raise UndogenError(f"No journal entry #{entry}")
        elif entry is None:
            target = next((e for e in reversed(self.journal) if e["status"] != "undone"), None)
            if target is None:
                raise UndogenError("Nothing to undo")
        else:
            target = entry
        if target["status"] == "undone":
            raise UndoError(f"Entry #{target['seq']} is already undone", target)

        dependents = self.dependents_of(target)
        if dependents:
            # With cascade_within, a dependent from another session anywhere a cascade would reach refuses the undo
            # before anything is undone (checked once, at the top).
            others = (
                [d for d in self.all_dependents_of(target) if d.get("session") != cascade_within]
                if cascade_within is not None and not _dependents_checked
                else []
            )
            if not cascade:
                raise DependencyError(target, dependents, others=others)
            if others:
                raise DependencyError(target, others, cascade_refused=True)

        # An entry that can't be undone at all is refused before its dependents are touched.
        if not target.get("inverse") and target["plan"]["strategy"] != "no-side-effects" and not target.get("noop"):
            target["status"] = "failed"
            target["undoError"] = f"cannot be undone: {target.get('inverseError')}"
            self._persist(target)
            raise UndoError(f"Entry #{target['seq']} ({target['operationId']}) cannot be undone: {target.get('inverseError')}", target)
        # Undo what depends on this entry first: its own conflict check then compares against the state those writes
        # were undone to (a create edited later in the same session is cascaded back, not refused as changed). An error
        # after that leaves the dependents undone; every such error says which.
        for d in reversed(dependents):
            if d["status"] != "undone":
                self.undo(d, force=force, cascade=True, cascade_within=cascade_within, _dependents_checked=True)
        cascaded = [d for d in dependents if d["status"] == "undone"]
        also_undone = (
            " The writes that depended on it were already undone: " + ", ".join(f"#{d['seq']} {d['operationId']}" for d in cascaded) + "."
            if cascaded
            else ""
        )

        if not target.get("inverse") and target["plan"]["strategy"] == "no-side-effects":
            return self._finish(target, {"status": 204, "data": None, "headers": {}})
        if target.get("noop"):
            target.setdefault("undoWarnings", []).append("the call changed nothing, so there was nothing to undo")
            return self._finish(target, {"status": 204, "data": None, "headers": {}})
        if not target.get("inverse"):
            target["status"] = "failed"
            target["undoError"] = f"cannot be undone: {target.get('inverseError')}"
            self._persist(target)
            raise UndoError(f"Entry #{target['seq']} ({target['operationId']}) cannot be undone: {target.get('inverseError')}", target)

        inverse = self._remap_request(target["inverse"])
        headers: Dict[str, str] = {}
        check = target.get("check")
        if check and not force and self.check_conflicts:
            check_path = fill_path(check["pathTemplate"], self._remap_params(check["params"]))
            current = self.request("get", check_path, query=check.get("query"))
            if check.get("mode") == "diff":
                conflicts = _compare(check["expected"], _state_of(current), "", target["session"])
                if conflicts:
                    return self._conflict(target, conflicts, current, cascaded)
            else:
                if current["status"] in (404, 410):
                    if inverse["method"] == "delete":
                        target.setdefault("undoWarnings", []).append("the resource was already gone")
                        return self._finish(target, current)
                    return self._conflict(target, [{"field": "(resource)", "expected": "exists", "actual": f"HTTP {current['status']}"}], current, cascaded)
                if current["status"] >= 300:
                    raise UndoError(
                        f"Undo of #{target['seq']}: could not read current state (GET {check_path} -> HTTP {current['status']})"
                        + (f".{also_undone}" if also_undone else ""),
                        target,
                        current,
                    )
                conflicts = _compare(check["expected"], current["data"], "", target["session"])
                if conflicts:
                    return self._conflict(target, conflicts, current, cascaded)
            etag = current["headers"].get("etag")  # read after the cascade, so it covers the inverse request
            # If-Match uses strong comparison: a weak W/ validator would always fail with 412.
            if etag and not etag.startswith("W/") and check_path == inverse["path"]:
                headers["if-match"] = etag

        if self.idempotency_header:
            headers[str(self.idempotency_header)] = f"undogen-{target['session']}-{target['seq']}-undo"
        target["undoAttempts"] = target.get("undoAttempts", 0) + 1
        res = self.request(
            inverse["method"],
            inverse["path"],
            query=inverse.get("query"),
            body=inverse.get("body"),
            content_type=inverse.get("contentType"),
            headers=headers,
            # A POST retried after a timeout/5xx could create the resource twice if the API ignores the key.
            idempotent=inverse["method"] != "post",
        )
        target["undoResponse"] = res
        if res["status"] == 412:
            return self._conflict(target, [{"field": "(etag)", "expected": headers.get("if-match"), "actual": "changed"}], res, cascaded)
        if res["status"] >= 400 and not (inverse["method"] == "delete" and res["status"] in (404, 410)):
            target["status"] = "failed"
            target["undoError"] = f"{inverse['method'].upper()} {inverse['path']} -> HTTP {res['status']}"
            self._persist(target)
            raise UndoError(
                f"Undo of #{target['seq']} ({target['operationId']}) failed: {target['undoError']}" + (f".{also_undone}" if also_undone else ""), target, res
            )

        identity = target.get("identity")
        if identity and inverse["method"] == "post":
            old = (target["request"].get("params") or {}).get(identity["param"])
            new = get_path(res["data"], identity["responseKey"])
            if new is None:
                new = get_path(res["data"], "id")
            if old is not None and new is not None:
                self._record_id(target, identity["param"], old, new)
        if target.get("children"):
            self._restore_children(target)
        return self._finish(target, res)

    def checkpoint(self) -> int:
        """Mark the current point in the journal; undo_to(checkpoint) rolls back everything done since."""
        return self._seq

    def undo_to(self, checkpoint: int, *, force: bool = False) -> dict:
        """Undo every entry made after `checkpoint`, newest first."""
        return self.undo_all(force=force, after=checkpoint)

    def undo_all(self, *, force: bool = False, cascade: bool = False, after: Optional[int] = None, session: Optional[str] = None) -> dict:
        """Undo everything (or everything after a checkpoint, or one session's writes), newest first.
        Continues past failures and reports them."""
        undone, failed = [], []
        for entry in reversed(list(self.journal)):
            if entry["status"] == "undone":
                continue
            if after is not None and entry["seq"] <= after:
                continue
            if session is not None and entry.get("session") != session:
                continue
            try:
                # Rolling back one session never cascades into another session's writes.
                self.undo(entry, force=force, cascade=cascade, cascade_within=session)
                undone.append(entry)
            except UndogenError as err:
                failed.append({"entry": entry, "error": err})
        return {"undone": undone, "failed": failed}

    def remap_id(self, param: str, value: Scalar) -> Scalar:
        cur = value
        for _ in range(32):
            known = self._id_map.get(param, {})
            # Journals written before ids were keyed JavaScript-style used str(): look both up.
            nxt = next((known[f] for f in _id_forms(cur) if f in known), None)
            rounded = _ts_rounded(cur)
            if nxt is None and rounded is not None and rounded in known:
                nxt = known[rounded]  # written by the TypeScript runtime, which only has the rounded spelling
            if nxt is None:
                return cur
            cur = nxt
        return cur

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Dict[str, Any]] = None,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
        content_type: Optional[str] = None,
        idempotent: Optional[bool] = None,
    ) -> dict:
        """Low-level request, not journaled. Retries 429s, and timeouts/5xx when safe to repeat."""
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: _query_value(v) for k, v in query.items()})
        base = self.headers() if callable(self.headers) else (self.headers or {})
        # Configured headers (credentials) always win over per-call ones, whatever their case.
        merged: Dict[str, Any] = {}
        for layer in ({"accept": "application/json"}, headers or {}, base):
            for k, v in layer.items():
                merged[k.lower()] = (k, v)
        all_headers = dict(merged.values())
        data, ct = _encode_body(body, content_type)
        if ct:
            all_headers["content-type"] = ct
        out = OutgoingRequest(method.upper(), url, all_headers, data)
        if self.before_request:
            self.before_request(out)
        can_retry = idempotent if idempotent is not None else method.lower() in ("get", "put", "delete")
        attempt = 0
        while True:
            req = urllib.request.Request(out.url, data=out.body, headers=out.headers, method=out.method)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return _result(resp.status, resp.read(), dict(resp.headers.items()))
            except urllib.error.HTTPError as err:
                status = err.code
                raw = err.read()
                hdrs = dict(err.headers.items()) if err.headers else {}
                # 429, or a 403 that says when to retry (GitHub's secondary rate limits), means "slow down".
                rate_limited = status == 429 or (status == 403 and any(k.lower() == "retry-after" for k in hdrs))
                transient = rate_limited or (status in (502, 503, 504) and can_retry)
                if transient and attempt < self.retries:
                    lower = {k.lower(): v for k, v in hdrs.items()}
                    time.sleep(_retry_after(lower.get("retry-after")) or self.retry_delay * 2**attempt)
                    attempt += 1
                    continue
                return _result(status, raw, hdrs)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                if can_retry and attempt < self.retries:
                    time.sleep(self.retry_delay * 2**attempt)
                    attempt += 1
                    continue
                raise UndogenError(f"{out.method} {path} failed: {err}") from err

    # -- internals ------------------------------------------------------------

    def _persist(self, entry: dict) -> None:
        """Save to the store; with journal_detail='minimal', without the bodies undo doesn't need."""
        if self.journal_detail != "minimal":
            self.store.save(entry)
            return
        slim = {**entry, "request": {**entry["request"], "body": None}, "response": {"status": entry["response"]["status"], "data": None, "headers": {}}}
        refs = _body_refs(entry["request"].get("body"), entry["session"])
        if refs:
            slim["request"]["bodyRefs"] = refs
        if entry.get("check"):
            slim["check"] = {**entry["check"], "expected": _hash_values(entry["check"]["expected"], entry["session"])}
        slim.pop("before", None)
        if entry.get("undoResponse"):
            slim["undoResponse"] = {"status": entry["undoResponse"]["status"], "data": None, "headers": {}}
        self.store.save(slim)

    def _finish(self, target: dict, res: dict) -> dict:
        target["status"] = "undone"
        target["undone"] = True
        target.pop("undoError", None)
        self._persist(target)
        return res

    def _conflict(self, target: dict, conflicts: List[dict], res: dict, cascaded: Optional[List[dict]] = None):
        target["status"] = "conflict"
        target["undoError"] = "state changed since the call"
        self._persist(target)
        note = ", ".join(f"#{d['seq']} {d['operationId']}" for d in cascaded or [])
        raise ConflictError(target, conflicts, res, f" The writes that depended on it were already undone: {note}." if note else "")

    def _record_id(self, entry: dict, param: str, old: Scalar, new: Scalar) -> None:
        for form in _id_forms(old):  # every exact spelling
            entry.setdefault("idMap", {}).setdefault(param, {})[form] = new
            self._id_map.setdefault(param, {})[form] = new

    def _remap_params(self, params: Dict[str, Scalar]) -> Dict[str, Scalar]:
        return {k: self.remap_id(k, v) for k, v in params.items()}

    def _remap_request(self, req: dict) -> dict:
        if not req.get("pathTemplate") or req.get("params") is None:
            return req
        params = self._remap_params(req["params"])
        return {**req, "params": params, "path": fill_path(req["pathTemplate"], params)}

    def _capture_children(self, plans: List[dict], params: Dict[str, Scalar]) -> List[dict]:
        out = []
        for child in plans:
            try:
                path = fill_path(child["list"]["path"], params)
            except UndogenError:
                continue
            res = self.request("get", path)
            if res["status"] >= 300 or not isinstance(res["data"], list):
                continue
            group: Dict[str, Any] = {"plan": child, "params": dict(params), "items": res["data"]}
            if child.get("children"):
                nested = []
                for item in res["data"]:
                    cid = get_path(item, child["idKey"])
                    nested.append([] if cid is None else self._capture_children(child["children"], {**params, child["param"]: cid}))
                group["itemChildren"] = nested
            out.append(group)
        return out

    def _restore_children(self, target: dict, groups: Optional[List[dict]] = None) -> None:
        for group in target.get("children") or [] if groups is None else groups:
            params = self._remap_params(group["params"])
            create = group["plan"]["create"]
            for index, item in enumerate(group["items"]):
                fields = create["body"]["fields"]
                body = item if fields == "*" else {k: item[k] for k in fields if isinstance(item, dict) and k in item}
                op = self.bundle.operations.get(create["operationId"], {})
                res = self.request("post", fill_path(create["path"], params), body=body, content_type=op.get("requestContentType"))
                if res["status"] >= 300:
                    target.setdefault("undoWarnings", []).append(f"re-creating a child with {create['operationId']} failed: HTTP {res['status']}")
                    continue
                old, new = get_path(item, group["plan"]["idKey"]), get_path(res["data"], group["plan"]["idKey"])
                if old is not None and new is not None:
                    self._record_id(target, group["plan"]["param"], old, new)
                nested = (group.get("itemChildren") or [None] * len(group["items"]))[index]
                if nested:
                    self._restore_children(target, nested)

    def _lookup(self, ref: dict, sources: dict) -> Any:
        if ref["from"] == "location":
            loc = (sources.get("responseHeaders") or {}).get("location")
            if not loc:
                return None
            last = [s for s in urllib.parse.urlparse(loc).path.split("/") if s]
            return urllib.parse.unquote(last[-1]) if last else None
        return get_path(sources.get(ref["from"]), ref["key"])

    def _resolve_params(self, template: dict, sources: dict) -> Dict[str, Scalar]:
        out = {}
        for name, ref in template["bindings"].items():
            v = self._lookup(ref, sources)
            if v is None:
                key = f".{ref['key']}" if ref.get("key") else ""
                raise UndogenError(f"Cannot resolve {{{name}}} from {ref['from']}{key}")
            out[name] = v
        return out

    def _resolve_path(self, template: dict, sources: dict) -> str:
        return fill_path(template["path"], self._resolve_params(template, sources))

    def _resolve_query(self, template: dict, sources: dict) -> Optional[Dict[str, Any]]:
        if not template.get("query"):
            return None
        out = {}
        for name, ref in template["query"].items():
            v = self._lookup(ref, sources)
            if v is not None:
                out[name] = v
        return out or None

    def _resolve_request(self, template: dict, sources: dict) -> dict:
        params = self._resolve_params(template, sources)
        op = self.bundle.operations.get(template["operationId"], {})
        return {
            "operationId": template["operationId"],
            "method": template["method"],
            "path": fill_path(template["path"], params),
            "pathTemplate": template["path"],
            "params": params,
            "query": self._resolve_query(template, sources),
            "body": _resolve_body(template.get("body"), sources),
            "contentType": op.get("requestContentType"),
        }


def _loose_key(k: str) -> str:
    return k.lower().replace("_", "").replace("-", "").replace(" ", "")


def loose_get(obj: Any, key: str):
    """(found, value), tolerating case/separator differences (FriendlyName vs friendly_name)."""
    if not isinstance(obj, dict):
        return False, None
    if key in obj:
        return True, obj[key]
    want = _loose_key(key)
    for k, v in obj.items():
        if _loose_key(k) == want:
            return True, v
    return False, None


def _resolve_body(body: Optional[dict], sources: dict) -> Any:
    if not body:
        return None
    kind = body["from"]
    if kind == "request":
        req = sources.get("request")
        fields = body.get("fields")
        if fields is not None and isinstance(req, dict):
            return {k: req[k] for k in fields if k in req}
        return req
    if kind == "literal":
        return body.get("value")
    if kind == "fields":
        out = {}
        for k, ref in body["fields"].items():
            if ref["from"] == "location":
                continue
            v = get_path(sources.get(ref["from"]), ref["key"])
            if v is not None:
                out[k] = v
        return out
    before = sources.get("before")
    if before is None:
        raise UndogenError("No captured state to restore from")
    if kind == "before":
        fields = body["fields"]
        return before if fields == "*" else {k: before[k] for k in fields if isinstance(before, dict) and k in before}
    if kind == "before-request-keys":
        return _restore_sent(sources.get("request"), before, bool(body.get("nullMissing")))
    if kind == "before-json-patch":
        return invert_json_patch(sources.get("request"), before)
    raise UndogenError(f"Unknown body template {kind}")


def json_patch_members(patch: Any) -> Optional[List[str]]:
    """Top-level members an RFC 6902 patch touches (targets, and the sources of move)."""
    if not isinstance(patch, list) or not all(isinstance(o, dict) and isinstance(o.get("op"), str) and isinstance(o.get("path"), str) for o in patch):
        return None
    out: List[str] = []
    for o in patch:
        paths = [o["path"]] + ([o["from"]] if o["op"] == "move" and isinstance(o.get("from"), str) else [])
        for p in paths:
            member = "" if p == "" else (p.split("/") + [""])[1].replace("~1", "/").replace("~0", "~")
            if member not in out:
                out.append(member)
    return out


def invert_json_patch(patch: Any, before: Any) -> List[dict]:
    members = json_patch_members(patch)
    if members is None:
        raise UndogenError("The request body is not a JSON Patch")
    if "" in members:
        return [{"op": "replace", "path": "", "value": before}]
    prior = before if isinstance(before, dict) else {}
    esc = lambda m: m.replace("~", "~0").replace("/", "~1")  # noqa: E731
    return [{"op": "add", "path": f"/{esc(m)}", "value": prior[m]} if m in prior else {"op": "remove", "path": f"/{esc(m)}"} for m in members]


ENVELOPE_NAMES = {"data", "attributes"}
ENVELOPE_SIBLINGS = {"meta", "links", "included", "jsonapi", "errors"}


def _envelope_keys(body: dict, state: Any) -> set:
    """Keys of `body` that wrap the resource (JSON:API data/attributes, or a single key holding the whole
    representation, like Asana's {"data": {...}}), as opposed to fields such as {"settings": {...}}."""
    out = set()
    if not isinstance(state, dict):
        return out
    for k, v in body.items():
        found, inner = loose_get(state, k)
        if not isinstance(v, dict) or not isinstance(inner, dict):
            continue
        wraps_all = len(body) == 1 and all(loose_get({x: 0}, k)[0] or x in ENVELOPE_SIBLINGS for x in state)
        if k in ENVELOPE_NAMES or wraps_all:
            out.add(k)
    return out


def _restore_sent(request: Any, before: Any, null_missing: bool) -> dict:
    """The previous values of exactly the fields `request` sent, following envelopes into nested objects."""
    out: Dict[str, Any] = {}
    if not isinstance(request, dict):
        return out
    nested = _envelope_keys(request, before)
    for k, v in request.items():
        found, value = loose_get(before, k)
        if k in nested:
            out[k] = _restore_sent(v, value, null_missing)
        elif found:
            out[k] = value
        elif null_missing:
            out[k] = None  # merge patch: null removes the key the call added
    return out


def _expected_state(request: Any, response: Any, only_echoed: bool) -> dict:
    patched = json_patch_members(request)
    if patched is not None and isinstance(response, dict):
        return {m: response.get(m) for m in patched if m}
    if not isinstance(request, dict):
        return {}
    res = response if isinstance(response, dict) else None
    nested = _envelope_keys(request, res)
    out = {}
    for k, v in request.items():
        found, value = loose_get(res, k)
        if k in nested:
            inner = _expected_state(v, value, only_echoed)
            if inner:
                out[k] = inner
        elif found:
            out[k] = value
        elif not only_echoed:
            out[k] = v
    return out


VOLATILE_FIELDS = {
    "createdAt", "updatedAt", "created_at", "updated_at", "modifiedAt", "modified_at",
    "lastModified", "last_modified", "etag", "ETag",
}


def _state_of(res: dict) -> dict:
    data = res["data"] if isinstance(res.get("data"), dict) and res["status"] < 300 else {}
    return {"(status)": res["status"], **data}


def _changed_state(before: dict, after: dict) -> dict:
    """The fields that differ between two reads, with their new values ("(status)" for the HTTP status)."""
    if before["status"] != after["status"]:
        return {"(status)": after["status"]}
    a, b = _state_of(before), _state_of(after)
    return {k: b.get(k) for k in {*a, *b} - VOLATILE_FIELDS if _stable(a.get(k)) != _stable(b.get(k))}


HASHED = "$undogenSha256"


def _stable_js(v: Any) -> str:
    """JSON like the TypeScript stableStringify (sorted keys, no spaces), so hashes match across runtimes."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _created_binding(template: dict) -> Optional[str]:
    """The parameter naming the resource a create made (same rule as TypeScript's createdBinding)."""
    params = re.findall(r"\{([^}]+)\}", template["path"])
    ref = template["bindings"].get(params[-1]) if params else None
    if ref and ref["from"] in ("response", "request", "location"):
        return params[-1]
    for name, r in template["bindings"].items():
        if r["from"] in ("response", "location"):
            return name
    return None


def _hash_values(expected: dict, salt: str) -> dict:
    out = {}
    for k, v in expected.items():
        if isinstance(v, dict) and HASHED in v:
            out[k] = v  # already hashed (an entry saved again)
        elif isinstance(v, dict):
            out[k] = _hash_values(v, salt)
        else:
            out[k] = {HASHED: hashlib.sha256((salt + _stable_js(v)).encode()).hexdigest()}
    return out


def _contains_hash(v: Any) -> bool:
    return isinstance(v, dict) and (HASHED in v or any(_contains_hash(x) for x in v.values()))


def _compare(expected: dict, current: Any, prefix: str = "", salt: str = "") -> List[dict]:
    cur = current if isinstance(current, dict) else {}
    nested = _envelope_keys(expected, cur)
    out = []
    for k, v in expected.items():
        actual = loose_get(cur, k)[1]
        if isinstance(v, dict) and HASHED in v:
            if hashlib.sha256((salt + _stable_js(actual)).encode()).hexdigest() != v[HASHED]:
                out.append({"field": prefix + k, "expected": "(hidden: journal_detail is minimal)", "actual": actual})
        elif k in nested or _contains_hash(v):
            out.extend(_compare(v, actual, f"{prefix}{k}.", salt))
        elif _stable(actual) != _stable(v):
            out.append({"field": prefix + k, "expected": v, "actual": actual})
    return out


def _query_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _encode_body(body: Any, content_type: Optional[str]):
    if body is None:
        return None, None
    ct = content_type or "application/json"
    if "x-www-form-urlencoded" in ct:
        pairs = []
        for k, v in (body or {}).items():
            for item in v if isinstance(v, list) else [v]:
                if item is not None:
                    pairs.append((k, json.dumps(item) if isinstance(item, (dict, list)) else _query_value(item)))
        return urllib.parse.urlencode(pairs).encode(), "application/x-www-form-urlencoded"
    if "multipart/form-data" in ct:
        return _multipart(body or {})
    if ct.startswith("text/"):
        return str(body).encode(), ct
    return json.dumps(body).encode(), ct if "json" in ct else "application/json"


def _multipart(fields: dict):
    """Encode a multipart/form-data body. Values may be scalars, dicts/lists (sent as JSON), bytes,
    or (filename, bytes[, content_type]) tuples for files."""
    boundary = "undogen-" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        for item in value if isinstance(value, list) and not isinstance(value, (bytes, bytearray)) else [value]:
            if item is None:
                continue
            out += f"--{boundary}\r\n".encode()
            if isinstance(item, tuple):
                filename, data = item[0], item[1]
                ctype = item[2] if len(item) > 2 else "application/octet-stream"
                out += f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
                out += data if isinstance(data, (bytes, bytearray)) else str(data).encode()
            elif isinstance(item, (bytes, bytearray)):
                out += f'Content-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()
                out += item
            else:
                text = json.dumps(item) if isinstance(item, (dict, list)) else _query_value(item)
                out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + text.encode()
            out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def _result(status: int, raw: bytes, headers: Dict[str, str]) -> dict:
    text = raw.decode("utf-8", errors="replace") if raw else ""
    data: Any = None
    if text:
        try:
            data = json.loads(text)
        except ValueError:
            data = text
    return {"status": status, "data": data, "headers": {k.lower(): v for k, v in headers.items()}}


def _retry_after(value: Optional[str]) -> Optional[float]:
    """Seconds to wait from a Retry-After header: a number of seconds or an HTTP date, capped at 60."""
    if not value:
        return None
    try:
        return min(max(float(value), 0.0), 60.0)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(value)
        return min(max((when - datetime.now(when.tzinfo or timezone.utc)).total_seconds(), 0.0), 60.0)
    except (TypeError, ValueError):
        return None
