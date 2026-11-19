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
import hashlib
import json
import os
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

    def __init__(self, entry: dict, conflicts: List[dict], response: Optional[dict] = None):
        what = "; ".join(f"{c['field']}: expected {json.dumps(c['expected'])}, found {json.dumps(c['actual'])}" for c in conflicts)
        super().__init__(
            f"Undo of #{entry['seq']} ({entry['operationId']}) refused: the state it wrote has changed since ({what}). "
            "Pass force=True to overwrite anyway.",
            entry,
            response,
        )
        self.conflicts = conflicts


class DependencyError(UndoError):
    def __init__(self, entry: dict, dependents: List[dict]):
        names = ", ".join(f"#{d['seq']} {d['operationId']}" for d in dependents)
        super().__init__(
            f"Undo of #{entry['seq']} ({entry['operationId']}) would orphan later writes that use it: {names}. "
            "Undo those first, or pass cascade=True.",
            entry,
        )
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
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")


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
            out.append(urllib.parse.quote(str(params[name]), safe=""))
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
        self.journal: List[dict] = []
        self._id_map: Dict[str, Dict[str, Scalar]] = {}
        for entry in self.store.load():
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
            fingerprint = hashlib.sha256(
                _stable({"operationId": operation_id, "params": params, "query": query, "body": body}).encode()
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
        if inverse and plan.get("check") and self.check_conflicts:
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
            for name, ref in template["bindings"].items():
                if ref["from"] in ("response", "location") and inverse["params"].get(name) is not None:
                    entry["created"] = {"param": name, "value": inverse["params"][name]}
                    break
        self.journal.append(entry)
        self.store.save(entry)
        return {**response, "entry": entry}

    def dependents_of(self, entry: dict) -> List[dict]:
        created = entry.get("created")
        if not created:
            return []
        param, value = created["param"], created["value"]
        ids = {str(value), str(self.remap_id(param, value))}
        return [
            e
            for e in self.journal
            if e["seq"] > entry["seq"]
            and e["status"] != "undone"
            and e["plan"]["strategy"] != "no-side-effects"
            and e.get("inverse") is not None
            and str((e["request"].get("params") or {}).get(param)) in ids
        ]

    def undo(self, entry: Union[dict, int, None] = None, *, force: bool = False, cascade: bool = False) -> dict:
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
            if not cascade:
                raise DependencyError(target, dependents)
            for d in reversed(dependents):
                if d["status"] != "undone":
                    self.undo(d, force=force, cascade=True)

        if not target.get("inverse") and target["plan"]["strategy"] == "no-side-effects":
            return self._finish(target, {"status": 204, "data": None, "headers": {}})
        if not target.get("inverse"):
            target["status"] = "failed"
            target["undoError"] = f"cannot be undone: {target.get('inverseError')}"
            self.store.save(target)
            raise UndoError(f"Entry #{target['seq']} ({target['operationId']}) cannot be undone: {target.get('inverseError')}", target)

        inverse = self._remap_request(target["inverse"])
        headers: Dict[str, str] = {}
        check = target.get("check")
        if check and not force and self.check_conflicts:
            check_path = fill_path(check["pathTemplate"], self._remap_params(check["params"]))
            current = self.request("get", check_path, query=check.get("query"))
            if current["status"] in (404, 410):
                if inverse["method"] == "delete":
                    target.setdefault("undoWarnings", []).append("the resource was already gone")
                    return self._finish(target, current)
                return self._conflict(target, [{"field": "(resource)", "expected": "exists", "actual": f"HTTP {current['status']}"}], current)
            if current["status"] >= 300:
                raise UndoError(f"Undo of #{target['seq']}: could not read current state (GET {check_path} -> HTTP {current['status']})", target, current)
            conflicts = _compare(check["expected"], current["data"])
            if conflicts:
                return self._conflict(target, conflicts, current)
            etag = current["headers"].get("etag")
            if etag and check_path == inverse["path"]:
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
            return self._conflict(target, [{"field": "(etag)", "expected": headers.get("if-match"), "actual": "changed"}], res)
        if res["status"] >= 400 and not (inverse["method"] == "delete" and res["status"] in (404, 410)):
            target["status"] = "failed"
            target["undoError"] = f"{inverse['method'].upper()} {inverse['path']} -> HTTP {res['status']}"
            self.store.save(target)
            raise UndoError(f"Undo of #{target['seq']} ({target['operationId']}) failed: {target['undoError']}", target, res)

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

    def undo_all(self, *, force: bool = False) -> dict:
        """Undo everything, newest first. Continues past failures and reports them."""
        undone, failed = [], []
        for entry in reversed(list(self.journal)):
            if entry["status"] == "undone":
                continue
            try:
                self.undo(entry, force=force)
                undone.append(entry)
            except UndogenError as err:
                failed.append({"entry": entry, "error": err})
        return {"undone": undone, "failed": failed}

    def remap_id(self, param: str, value: Scalar) -> Scalar:
        cur = value
        for _ in range(32):
            nxt = self._id_map.get(param, {}).get(str(cur))
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
        all_headers = {"accept": "application/json", **base, **(headers or {})}
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
                transient = status == 429 or (status in (502, 503, 504) and can_retry)
                if transient and attempt < self.retries:
                    time.sleep(_retry_after(hdrs.get("Retry-After")) or self.retry_delay * 2**attempt)
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

    def _finish(self, target: dict, res: dict) -> dict:
        target["status"] = "undone"
        target["undone"] = True
        target.pop("undoError", None)
        self.store.save(target)
        return res

    def _conflict(self, target: dict, conflicts: List[dict], res: dict):
        target["status"] = "conflict"
        target["undoError"] = "state changed since the call"
        self.store.save(target)
        raise ConflictError(target, conflicts, res)

    def _record_id(self, entry: dict, param: str, old: Scalar, new: Scalar) -> None:
        entry.setdefault("idMap", {}).setdefault(param, {})[str(old)] = new
        self._id_map.setdefault(param, {})[str(old)] = new

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
        return sources.get("request")
    if kind == "literal":
        return body.get("value")
    before = sources.get("before")
    if before is None:
        raise UndogenError("No captured state to restore from")
    if kind == "before":
        fields = body["fields"]
        return before if fields == "*" else {k: before[k] for k in fields if isinstance(before, dict) and k in before}
    if kind == "before-request-keys":
        req = sources.get("request")
        out = {}
        for k in list(req.keys()) if isinstance(req, dict) else []:
            found, value = loose_get(before, k)
            if found:
                out[k] = value
            elif body.get("nullMissing"):
                out[k] = None  # merge patch: null removes the key the call added
        return out
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


def _expected_state(request: Any, response: Any, only_echoed: bool) -> dict:
    patched = json_patch_members(request)
    if patched is not None and isinstance(response, dict):
        return {m: response.get(m) for m in patched if m}
    if not isinstance(request, dict):
        return {}
    res = response if isinstance(response, dict) else None
    out = {}
    for k, v in request.items():
        found, value = loose_get(res, k)
        if found:
            out[k] = value
        elif not only_echoed:
            out[k] = v
    return out


def _compare(expected: dict, current: Any) -> List[dict]:
    out = []
    for k, v in expected.items():
        actual = loose_get(current, k)[1]
        if _stable(actual) != _stable(v):
            out.append({"field": k, "expected": v, "actual": actual})
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
    if not value:
        return None
    try:
        return min(max(float(value), 0.0), 60.0)
    except ValueError:
        return None
