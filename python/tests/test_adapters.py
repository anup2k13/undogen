import asyncio
import json

import pytest

from undogen import UndoableClient

langchain_core = pytest.importorskip("langchain_core")


def test_langchain_tools(bundle_path, server_url):
    from undogen.adapters.langchain import to_langchain_tools

    client = UndoableClient(bundle_path, server_url)
    tools = {t.name: t for t in to_langchain_tools(client, only=["createTodo", "sendReminder"])}
    assert set(tools) == {"createTodo", "sendReminder", "undogen_undo", "undogen_undo_all", "undogen_journal"}
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
