import asyncio
import json

import pytest

from undogen import UndoableClient

langchain_core = pytest.importorskip("langchain_core")


def test_langchain_tools(bundle_path, server_url):
    from undogen.adapters.langchain import to_langchain_tools

    client = UndoableClient(bundle_path, server_url)
    tools = {t.name: t for t in to_langchain_tools(client, only=["createTodo", "sendReminder"])}
    assert set(tools) == {"createTodo", "sendReminder", "undogen_undo", "undogen_undo_all", "undogen_checkpoint", "undogen_preview", "undogen_journal"}
    out = json.loads(tools["createTodo"].invoke({"body": {"title": "lc"}}))
    assert out["status"] == 201
    refused = json.loads(tools["sendReminder"].invoke({"todoId": out["data"]["id"]}))
    assert refused["error"] == "IrreversibleOperationError"
    assert json.loads(tools["undogen_undo"].invoke({}))["status"] == 204


def test_openai_agents_tools(bundle_path, server_url):
    pytest.importorskip("agents")
    from undogen.adapters.openai_agents import to_openai_agents_tools

    client = UndoableClient(bundle_path, server_url)
    tools = {t.name: t for t in to_openai_agents_tools(client, only=["createTodo", "sendReminder"])}
    assert tools["sendReminder"].needs_approval is True
    assert tools["createTodo"].needs_approval is False
    out = json.loads(asyncio.run(tools["createTodo"].on_invoke_tool(None, json.dumps({"body": {"title": "oa"}}))))
    assert out["status"] == 201
    # Only reached after the SDK's approval step, so it runs.
    sent = json.loads(asyncio.run(tools["sendReminder"].on_invoke_tool(None, json.dumps({"todoId": out["data"]["id"]}))))
    assert sent["status"] == 202


def test_async_tools_do_not_block_the_event_loop(bundle_path, server_url):
    pytest.importorskip("agents")
    import time

    from undogen.adapters.langchain import to_langchain_tools
    from undogen.adapters.openai_agents import to_openai_agents_tools

    client = UndoableClient(bundle_path, server_url)
    original = client.request

    def slow_request(*a, **kw):
        time.sleep(0.3)  # a slow API
        return original(*a, **kw)

    client.request = slow_request
    oa = {t.name: t for t in to_openai_agents_tools(client, only=["listTodos"], undo_tools=False)}["listTodos"]
    lc = {t.name: t for t in to_langchain_tools(client, only=["listTodos"], undo_tools=False)}["listTodos"]

    async def main():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.02)
                ticks += 1

        counts = []
        for call in (lambda: oa.on_invoke_tool(None, "{}"), lambda: lc.ainvoke({})):
            ticks = 0
            t = asyncio.create_task(ticker())
            await call()
            t.cancel()
            counts.append(ticks)
        return counts

    # Each call waits 0.3s on the API; the event loop must keep running meanwhile.
    assert all(n >= 5 for n in asyncio.run(main()))


def test_model_arguments_cannot_approve_irreversible_calls(bundle_path, server_url):
    from undogen import tool_definitions
    from undogen.adapters.langchain import to_langchain_tools

    client = UndoableClient(bundle_path, server_url)
    tid = client.call("createTodo", body={"title": "x"})["data"]["id"]
    tools = {t.name: t for t in tool_definitions(client)}
    # The model smuggles approval (and an operation override) into its arguments.
    from undogen import IrreversibleOperationError

    with pytest.raises(IrreversibleOperationError):
        tools["sendReminder"].execute(todoId=tid, approved=True, _op={"id": "deleteTodo", "pathParams": ["todoId"]})
    compact = {t.name: t for t in tool_definitions(client, compact=True)}
    with pytest.raises(IrreversibleOperationError):
        compact["undogen_call"].execute(operation="sendReminder", input={"todoId": tid}, approved=True)
    lc = {t.name: t for t in to_langchain_tools(client, only=["sendReminder"])}
    assert json.loads(lc["sendReminder"].invoke({"todoId": tid, "approved": True}))["error"] == "IrreversibleOperationError"
    # Preview finds operations by the names compact search returns.
    assert compact["undogen_preview"].execute(tool="sendReminder")["needsApproval"] is True


def test_compact_preview_by_sanitized_name(bundle_path, server_url):
    from undogen import tool_definitions

    data = json.load(open(bundle_path))
    for op in data["operations"]:
        if op["id"] == "sendReminder":
            op["id"] = "todos/send-reminder"
    for p in data["plans"]:
        if p["operationId"] == "sendReminder":
            p["operationId"] = "todos/send-reminder"
    tools = {t.name: t for t in tool_definitions(UndoableClient(data, server_url), compact=True)}
    hit = tools["undogen_search"].execute(query="send reminder")["results"][0]["operation"]
    assert hit == "todos_send-reminder"
    assert tools["undogen_preview"].execute(tool=hit)["needsApproval"] is True
