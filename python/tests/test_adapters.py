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
