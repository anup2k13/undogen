"""Framework-neutral tool definitions backed by an UndoableClient (mirrors the TypeScript toolDefinitions)."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Set

from .client import UndoableClient, UndogenError

UNDO_TOOLS = ("undogen_undo", "undogen_undo_all", "undogen_journal", "undogen_preview", "undogen_checkpoint")


def describe_template(t: Optional[dict]) -> Optional[str]:
    """'DELETE /todos/{todoId} (todoId ← response.id)'."""
    if not t:
        return None
    binds = [
        f"{k} ← {'Location header' if r['from'] == 'location' else r['from'] + '.' + r['key']}"
        for k, r in t["bindings"].items()
        if r["from"] != "params"
    ]
    body = t.get("body") or {}
    kind = body.get("from")
    text = {
        "before": "body: the captured state",
        "before-request-keys": "body: the captured values of the fields sent",
        "before-json-patch": "body: a JSON Patch that puts back what the patch touched",
        "request": "body: the same request body",
    }.get(kind, f"body: {json.dumps(body.get('value'))}" if kind == "literal" else "")
    extra = "; ".join([*binds, text] if text else binds)
    return f"{t['method'].upper()} {t['path']}" + (f" ({extra})" if extra else "")


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: Dict[str, Any]
    annotations: Dict[str, Any]
    #: The trusted entry point: run(arguments, approved). `arguments` is the model's input as one dict;
    #: `approved` must come from the integration's own human-approval step, never from the model.
    run: Callable[[Dict[str, Any], bool], Any]
    operation_id: Optional[str] = None
    #: True when the operation is irreversible or unknown, so a human should approve each call.
    needs_approval: bool = False

    def execute(self, **arguments: Any) -> Any:
        """Call the tool with the model's arguments, without human approval."""
        return self.run(dict(arguments), False)


def _kw(func: Callable[..., Any]) -> Callable[[Dict[str, Any], bool], Any]:
    """Adapt a keyword function to run(arguments, approved); the model's arguments can't reach `approved`."""
    return lambda arguments, approved: func(**{k: v for k, v in (arguments or {}).items() if isinstance(k, str) and k.isidentifier()})


def tool_name(operation_id: str, taken: Set[str]) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", operation_id).strip("_")[:60] or "op"
    name, i = base, 2
    while name in taken:
        name = f"{base[: 60 - len(str(i))]}_{i}"
        i += 1
    taken.add(name)
    return name


def matches_only(op_id: str, only: Optional[List[str]]) -> bool:
    if not only:
        return True
    return any(op_id.startswith(p[:-1]) if p.endswith("*") else op_id == p for p in only)


def describe_entry(e: dict) -> dict:
    inv = e.get("inverse")
    out = {
        "seq": e["seq"],
        "operationId": e["operationId"],
        "request": f"{e['request']['method'].upper()} {e['request']['path']}",
        "status": e["status"],
        "reversibility": e["plan"]["reversibility"],
        "undo": f"{inv['method'].upper()} {inv['path']}" if inv else ("nothing to undo" if e["plan"]["strategy"] == "no-side-effects" else None),
    }
    if e.get("undoError"):
        out["undoError"] = e["undoError"]
    return out


def undo_note(plan: Optional[dict], op: dict) -> str:
    if op["method"] == "get":
        return "Read-only."
    if not plan:
        return "No undo plan."
    r = plan["reversibility"]
    if r == "reversible":
        return f"Undoable: undogen_undo runs {plan['inverse']['operationId']}." if plan.get("inverse") else "Undoable: changes nothing."
    if r == "compensable":
        return f"Undoable as a compensation ({(plan.get('caveats') or ['ids may change'])[0]})."
    if r == "irreversible":
        return f"IRREVERSIBLE: {(plan.get('reasons') or ['cannot be undone'])[0]}. Requires approval."
    return "Undo unknown: requires approval."


def _input_schema(op: dict) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    required: List[str] = []
    for p in op["pathParams"]:
        props[p] = {"type": "string", "description": f"Path parameter {{{p}}}"}
        required.append(p)
    if op.get("queryParams"):
        props["query"] = {
            "type": "object",
            "properties": {q["name"]: q.get("schema") or {"type": "string"} for q in op["queryParams"]},
        }
        if any(q.get("required") for q in op["queryParams"]):
            required.append("query")
    if op.get("headerParams"):
        props["headers"] = {
            "type": "object",
            "properties": {h["name"]: h.get("schema") or {"type": "string"} for h in op["headerParams"]},
            "required": [h["name"] for h in op["headerParams"] if h.get("required")],
        }
        if any(h.get("required") for h in op["headerParams"]):
            required.append("headers")
    if op["method"] != "get" and op.get("hasBody"):
        props["body"] = op.get("requestSchema") or {"type": "object"}
        required.append("body")
    return {"type": "object", "properties": props, "required": required}


STOPWORDS = {"a", "an", "the", "to", "of", "for", "in", "on", "by", "and", "or", "with", "from", "my", "all", "this", "that", "it", "is", "be", "as", "at", "into", "some", "new"}


def _stem(w: str) -> str:
    x = re.sub(r"ies$", "y", w)
    x = re.sub(r"(sses|ches|shes|xes)$", lambda m: m.group(0)[:-2], x)
    x = re.sub(r"([^s])s$", r"\1", x)
    if len(x) > 4:
        x = re.sub(r"(ing|ed)$", "", x)
    if len(x) > 3:
        x = re.sub(r"e$", "", x)
    return x


def _words(s: str) -> List[str]:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s or "").lower()
    return [_stem(w) for w in re.split(r"[^a-z0-9]+", s) if len(w) > 1 and w not in STOPWORDS]


def _search_index(client: UndoableClient, tools: List["ToolDefinition"]):
    """Rank operations for a query: field weights (summary/name > tags > path > description), IDF, phrase bonus."""
    docs = []
    for t in tools:
        op = client.bundle.operations[t.operation_id]
        fields = [
            (_words(op.get("summary") or ""), 3),
            (_words(op["id"].split("/")[-1]), 3),
            (_words(" ".join(op.get("tags") or [])), 2),
            (_words(re.sub(r"\{[^}]+\}", " ", op["path"])), 1),
            (_words((op.get("description") or "")[:300]), 0.5),
        ]
        weight: Dict[str, float] = {}
        for ws, w in fields:
            for x in ws:
                weight[x] = max(weight.get(x, 0), w)
        docs.append((t, weight, (op.get("summary") or "").lower(), bool(op.get("deprecated"))))
    df: Dict[str, int] = {}
    for _, weight, _, _ in docs:
        for w in weight:
            df[w] = df.get(w, 0) + 1
    idf = lambda w: math.log(1 + len(docs) / df.get(w, len(docs)))  # noqa: E731

    def rank(query: str) -> List["ToolDefinition"]:
        q = list(dict.fromkeys(_words(query)))
        phrase = query.lower().strip()
        scored = []
        for t, weight, summary, deprecated in docs:
            score = 0.0
            for w in q:
                if w in weight:
                    score += weight[w] * idf(w)
                elif len(w) >= 4:
                    hit = next(((x, v) for x, v in weight.items() if x.startswith(w) or (len(x) >= 4 and w.startswith(x))), None)
                    if hit:
                        score += hit[1] * idf(hit[0]) * 0.5
            if phrase and phrase in summary:
                score += 10
            if score > 0:
                scored.append((score * (0.3 if deprecated else 1), t))
        return [t for _, t in sorted(scored, key=lambda x: -x[0])]

    return rank


def _compact(client: UndoableClient, per_op: List["ToolDefinition"]) -> List["ToolDefinition"]:
    by_key: Dict[str, ToolDefinition] = {}
    for t in per_op:
        by_key[t.name] = t
        if t.operation_id:
            by_key[t.operation_id] = t
    rank = _search_index(client, per_op)

    def find(name: Any) -> "ToolDefinition":
        t = by_key.get(str(name or ""))
        if t is None:
            raise UndogenError(f'Unknown operation "{name}". Use undogen_search to find one.')
        return t

    def brief(t: "ToolDefinition") -> dict:
        op = client.bundle.operations[t.operation_id]
        return {"operation": t.name, "route": f"{op['method'].upper()} {op['path']}", "description": t.description}

    def search(query: str = "", limit: int = 10, **_: Any) -> dict:
        return {"results": [brief(t) for t in rank(query)[:limit]]}

    def describe(operation: str = "", **_: Any) -> dict:
        t = find(operation)
        return {**brief(t), "input": t.input_schema, "annotations": t.annotations}

    def call(arguments: Dict[str, Any], approved: bool) -> dict:
        given = arguments.get("input")
        return find(arguments.get("operation")).run(dict(given) if isinstance(given, dict) else {}, approved)

    return [
        ToolDefinition(
            name="undogen_search",
            description=f"Find API operations by what they do ({len(per_op)} available). Returns names for undogen_describe and undogen_call, and whether each can be undone.",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]},
            annotations={"title": "Search operations", "readOnlyHint": True},
            run=_kw(search),
        ),
        ToolDefinition(
            name="undogen_describe",
            description="The input schema of an operation found with undogen_search, and whether it can be undone. Makes no API calls.",
            input_schema={"type": "object", "properties": {"operation": {"type": "string"}}, "required": ["operation"]},
            annotations={"title": "Describe an operation", "readOnlyHint": True},
            run=_kw(describe),
        ),
        ToolDefinition(
            name="undogen_call",
            description="Call an operation by name with the input undogen_describe shows: { operation, input: { <path params>, query, headers, body } }. Writes are journaled and can be undone with undogen_undo.",
            input_schema={"type": "object", "properties": {"operation": {"type": "string"}, "input": {"type": "object"}}, "required": ["operation"]},
            annotations={"title": "Call an operation", "destructiveHint": True, "openWorldHint": True},
            run=call,
            needs_approval=any(t.needs_approval for t in per_op),
        ),
    ]


def tool_definitions(
    client: UndoableClient,
    only: Optional[List[str]] = None,
    include_reads: bool = True,
    undo_tools: bool = True,
    tags: Optional[List[str]] = None,
    compact: bool = False,
) -> List[ToolDefinition]:
    """One tool per operation (or, with compact=True, search/describe/call), plus undo and journal tools."""
    taken: Set[str] = set(UNDO_TOOLS)
    tools: List[ToolDefinition] = []
    for op in client.bundle.operations.values():
        if op["method"] == "get" and not include_reads:
            continue
        if not matches_only(op["id"], only):
            continue
        if tags and not any(t.lower() in {x.lower() for x in tags} for t in op.get("tags") or []):
            continue
        plan = client.plan_for(op["id"])
        reversible = op["method"] == "get" or (plan or {}).get("reversibility") == "reversible"
        risky = op["method"] != "get" and (plan or {}).get("reversibility") in ("irreversible", "unknown")

        def make_run(_op: dict) -> Callable[[Dict[str, Any], bool], Any]:
            def run(args: Dict[str, Any], approved: bool) -> dict:
                params = {p: args[p] for p in _op["pathParams"] if p in args}
                # Only declared header parameters: a tool call must not override Authorization or other headers.
                allowed = {h["name"].lower(): h["name"] for h in _op.get("headerParams") or []}
                given = args.get("headers") if isinstance(args.get("headers"), dict) else {}
                headers = {allowed[k.lower()]: str(v) for k, v in given.items() if k.lower() in allowed and v is not None} or None
                res = client.call(_op["id"], params=params, body=args.get("body"), query=args.get("query"), headers=headers, approved=approved)
                out = {"status": res["status"], "data": res["data"]}
                if res.get("entry"):
                    out["journal"] = describe_entry(res["entry"])
                return out

            return run

        tools.append(
            ToolDefinition(
                name=tool_name(op["id"], taken),
                operation_id=op["id"],
                description=f"{op.get('summary') or op['method'].upper() + ' ' + op['path']} {undo_note(plan, op)}",
                input_schema=_input_schema(op),
                annotations={
                    "title": op.get("summary") or op["id"],
                    "readOnlyHint": op["method"] == "get",
                    "destructiveHint": not reversible,
                    "idempotentHint": op["method"] in ("get", "put", "delete"),
                    "openWorldHint": True,
                },
                run=make_run(op),
                needs_approval=risky,
            )
        )
    per_operation = list(tools)  # undogen_preview looks names up here, compact or not
    if compact:
        tools = _compact(client, tools)
    if not undo_tools:
        return tools

    def undo(seq: Optional[int] = None, force: bool = False, cascade: bool = False, **_: Any) -> dict:
        # Agents act on their own session only: a persisted journal also holds earlier sessions' writes.
        mine = [e for e in client.journal if e.get("session") == client.session]
        entry = (
            next((e for e in mine if e["seq"] == seq), None)
            if seq is not None
            else next((e for e in reversed(mine) if e["status"] != "undone"), None)
        )
        if entry is None:
            if seq is not None and any(e["seq"] == seq for e in client.journal):
                raise UndogenError(f"Entry #{seq} belongs to an earlier session; a person can undo it with `undogen undo --journal`")
            raise UndogenError(f"No journal entry #{seq} in this session" if seq is not None else "Nothing to undo in this session")
        res = client.undo(entry, force=force, cascade=cascade)
        return {"status": res["status"], **({"journal": describe_entry(entry)} if entry else {})}

    def undo_all(force: bool = False, to: Optional[int] = None, **_: Any) -> dict:
        r = client.undo_all(force=force, after=to, session=client.session)
        return {
            "undone": [describe_entry(e) for e in r["undone"]],
            "failed": [{**describe_entry(f["entry"]), "error": str(f["error"])} for f in r["failed"]],
        }

    def journal(**_: Any) -> dict:
        return {"entries": [describe_entry(e) for e in client.journal if e.get("session") == client.session]}

    def preview(tool: str = "", **_: Any) -> dict:
        match = next((t for t in per_operation if t.name == tool or t.operation_id == tool), None)
        op = client.bundle.operations.get(match.operation_id if match and match.operation_id else tool)
        if op is None:
            raise UndogenError(f'Unknown tool or operation "{tool}"')
        name = match.name if match else op["id"]
        if op["method"] == "get":
            return {"tool": name, "reversibility": "read-only", "undo": "nothing to undo"}
        plan = client.plan_for(op["id"]) or {}
        out = {
            "tool": name,
            "operation": f"{op['method'].upper()} {op['path']}",
            "reversibility": plan.get("reversibility"),
            "strategy": plan.get("strategy"),
            "confidence": plan.get("confidence"),
            "needsApproval": plan.get("reversibility") in ("irreversible", "unknown"),
            "capture": describe_template(plan.get("capture")),
            "undo": describe_template(plan.get("inverse")) or ("nothing to undo" if plan.get("strategy") == "no-side-effects" else None),
            "reasons": plan.get("reasons", []),
            "caveats": plan.get("caveats", []),
        }
        if plan.get("inverseIfMissing"):
            out["undoIfNew"] = describe_template(plan["inverseIfMissing"])
        return out

    tools += [
        ToolDefinition(
            name="undogen_undo",
            description=(
                "Undo one earlier write (default: the most recent one not yet undone). Refuses if someone else changed the data "
                "since, unless force is true, and refuses to orphan later writes that depend on it, unless cascade is true."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "seq": {"type": "integer", "description": "Journal sequence number from undogen_journal"},
                    "force": {"type": "boolean"},
                    "cascade": {"type": "boolean"},
                },
                "required": [],
            },
            annotations={"title": "Undo a write", "destructiveHint": True, "openWorldHint": True},
            run=_kw(undo),
        ),
        ToolDefinition(
            name="undogen_undo_all",
            description=(
                "Roll back every write in this session, newest first, or only those made after a checkpoint "
                "from undogen_checkpoint. Reports what could not be undone."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "to": {"type": "integer", "description": "Checkpoint from undogen_checkpoint: undo only what was done after it"},
                    "force": {"type": "boolean"},
                },
                "required": [],
            },
            annotations={"title": "Undo all writes", "destructiveHint": True, "openWorldHint": True},
            run=_kw(undo_all),
        ),
        ToolDefinition(
            name="undogen_checkpoint",
            description=(
                "Mark this point before starting a task. If the task goes wrong, undogen_undo_all with "
                "{ to: checkpoint } rolls back only what was done since."
            ),
            input_schema={"type": "object", "properties": {}, "required": []},
            annotations={"title": "Checkpoint", "readOnlyHint": True},
            run=lambda arguments, approved: {"checkpoint": client.checkpoint()},
        ),
        ToolDefinition(
            name="undogen_preview",
            description=(
                "Before calling a tool, ask whether its effect can be undone and how: reversibility, the undo request, "
                "what is captured first, and caveats. Makes no API calls."
            ),
            input_schema={
                "type": "object",
                "properties": {"tool": {"type": "string", "description": "Tool name or operationId to preview"}},
                "required": ["tool"],
            },
            annotations={"title": "Preview undo", "readOnlyHint": True},
            run=_kw(preview),
        ),
        ToolDefinition(
            name="undogen_journal",
            description="List the writes made so far, whether each can be undone, and how.",
            input_schema={"type": "object", "properties": {}, "required": []},
            annotations={"title": "Journal", "readOnlyHint": True},
            run=_kw(journal),
        ),
    ]
    return tools
