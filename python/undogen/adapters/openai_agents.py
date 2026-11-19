"""OpenAI Agents SDK tools: ``pip install "undogen[openai-agents]"``.

    from agents import Agent
    from undogen import UndoableClient
    from undogen.adapters.openai_agents import to_openai_agents_tools

    client = UndoableClient("undogen.json", "https://sandbox.example.com")
    agent = Agent(name="ops", tools=to_openai_agents_tools(client))

Irreversible and unknown operations are marked ``needs_approval=True``, so the SDK's
human-in-the-loop flow asks before running them; once approved there, the call is made
with ``approved=True``. Pass ``needs_approval=False`` to rely on the client's own
``allow_irreversible`` gate instead.
"""

from __future__ import annotations

import json
from typing import Any, List, Optional

from ..client import UndogenError, UndoableClient
from ..tools import tool_definitions


def to_openai_agents_tools(
    client: UndoableClient,
    only: Optional[List[str]] = None,
    include_reads: bool = True,
    undo_tools: bool = True,
    needs_approval: bool = True,
) -> list:
    from agents import FunctionTool

    tools = []
    for d in tool_definitions(client, only=only, include_reads=include_reads, undo_tools=undo_tools):
        approval = needs_approval and d.needs_approval

        async def invoke(_ctx: Any, args_json: str, _d=d, _approved=approval) -> str:
            args = json.loads(args_json or "{}")
            try:
                # The SDK only invokes an approval-gated tool after a human approved it.
                result = _d.execute(approved=True, **args) if _approved else _d.execute(**args)
                return json.dumps(result)
            except UndogenError as err:
                return json.dumps({"error": type(err).__name__, "message": str(err)})

        tools.append(
            FunctionTool(
                name=d.name,
                description=d.description,
                params_json_schema=d.input_schema,
                on_invoke_tool=invoke,
                strict_json_schema=False,
                needs_approval=approval,
            )
        )
    return tools
