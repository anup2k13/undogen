"""LangChain / LangGraph tools: ``pip install "undogen[langchain]"``.

    from undogen import UndoableClient
    from undogen.adapters.langchain import to_langchain_tools

    client = UndoableClient("undogen.json", "https://sandbox.example.com")
    tools = to_langchain_tools(client)          # bind to a model or a LangGraph ToolNode

Irreversible calls go through the client's ``allow_irreversible`` gate; when a call is
refused, the tool returns the refusal as its result so the agent can explain or ask.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, List, Optional

from ..client import UndogenError, UndoableClient
from ..tools import tool_definitions


def _runners(d):
    """Sync and async callables for one tool. The model's arguments arrive as keywords but are passed on
    as one dict, never approved: LangChain has no approval step, so the client's allow_irreversible gate applies."""

    def run(**kwargs: Any) -> str:
        try:
            return json.dumps(d.run(dict(kwargs), False))
        except UndogenError as err:
            return json.dumps({"error": type(err).__name__, "message": str(err)})

    async def arun(**kwargs: Any) -> str:
        # The client is synchronous: keep async agents (LangGraph) responsive.
        return await asyncio.to_thread(run, **kwargs)

    return run, arun


def to_langchain_tools(
    client: UndoableClient,
    only: Optional[List[str]] = None,
    include_reads: bool = True,
    undo_tools: bool = True,
    tags: Optional[List[str]] = None,
    compact: bool = False,
) -> list:
    from langchain_core.tools import StructuredTool

    tools = []
    for d in tool_definitions(client, only=only, include_reads=include_reads, undo_tools=undo_tools, tags=tags, compact=compact):
        run, arun = _runners(d)
        tools.append(
            StructuredTool.from_function(
                func=run,
                coroutine=arun,
                name=d.name,
                description=d.description,
                args_schema=d.input_schema,
                infer_schema=False,
                metadata={"undogen": {"operationId": d.operation_id, "annotations": d.annotations, "needs_approval": d.needs_approval}},
            )
        )
    return tools
