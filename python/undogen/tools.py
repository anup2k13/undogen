"""Framework-neutral tool definitions backed by an UndoableClient (mirrors the TypeScript toolDefinitions)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Set

from .client import UndoableClient, UndogenError

UNDO_TOOLS = ("undogen_undo", "undogen_undo_all", "undogen_journal", "undogen_preview")


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
    #: Called with the tool arguments; returns a JSON-serialisable result.
    execute: Callable[..., Any]
    operation_id: Optional[str] = None
    #: True when the operation is irreversible or unknown, so a human should approve each call.
    needs_approval: bool = False


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


def tool_definitions(
    client: UndoableClient,
    only: Optional[List[str]] = None,
    include_reads: bool = True,
    undo_tools: bool = True,
) -> List[ToolDefinition]:
    taken: Set[str] = set(UNDO_TOOLS)
    tools: List[ToolDefinition] = []
    for op in client.bundle.operations.values():
        if op["method"] == "get" and not include_reads:
            continue
        if not matches_only(op["id"], only):
            continue
        plan = client.plan_for(op["id"])
        reversible = op["method"] == "get" or (plan or {}).get("reversibility") == "reversible"
        risky = op["method"] != "get" and (plan or {}).get("reversibility") in ("irreversible", "unknown")

        def execute(_op: dict = op, approved: bool = False, **args: Any) -> dict:
            params = {p: args[p] for p in _op["pathParams"] if p in args}
            headers = {k: str(v) for k, v in (args.get("headers") or {}).items()} or None
            res = client.call(_op["id"], params=params, body=args.get("body"), query=args.get("query"), headers=headers, approved=approved)
            out = {"status": res["status"], "data": res["data"]}
            if res.get("entry"):
                out["journal"] = describe_entry(res["entry"])
            return out

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
                execute=execute,
                needs_approval=risky,
            )
        )
    if not undo_tools:
        return tools

    def undo(seq: Optional[int] = None, force: bool = False, cascade: bool = False, **_: Any) -> dict:
        entry = (
            next((e for e in client.journal if e["seq"] == seq), None)
            if seq is not None
            else next((e for e in reversed(client.journal) if e["status"] != "undone"), None)
        )
        res = client.undo(entry if entry is not None else seq, force=force, cascade=cascade)
        return {"status": res["status"], **({"journal": describe_entry(entry)} if entry else {})}

    def undo_all(force: bool = False, **_: Any) -> dict:
        r = client.undo_all(force=force)
        return {
            "undone": [describe_entry(e) for e in r["undone"]],
            "failed": [{**describe_entry(f["entry"]), "error": str(f["error"])} for f in r["failed"]],
        }

    def journal(**_: Any) -> dict:
        return {"entries": [describe_entry(e) for e in client.journal]}

    def preview(tool: str = "", **_: Any) -> dict:
        match = next((t for t in tools if t.name == tool or t.operation_id == tool), None)
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
            execute=undo,
        ),
        ToolDefinition(
            name="undogen_undo_all",
            description="Roll back every write in this session, newest first. Reports what could not be undone.",
            input_schema={"type": "object", "properties": {"force": {"type": "boolean"}}, "required": []},
            annotations={"title": "Undo all writes", "destructiveHint": True, "openWorldHint": True},
            execute=undo_all,
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
            execute=preview,
        ),
        ToolDefinition(
            name="undogen_journal",
            description="List the writes made so far, whether each can be undone, and how.",
            input_schema={"type": "object", "properties": {}, "required": []},
            annotations={"title": "Journal", "readOnlyHint": True},
            execute=journal,
        ),
    ]
    return tools
