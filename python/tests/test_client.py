import json
import subprocess

import pytest

from undogen import (
    ConflictError,
    DependencyError,
    FileJournalStore,
    IrreversibleOperationError,
    ReplayBlockedError,
    UndoableClient,
    tool_definitions,
)

from .conftest import ROOT, TSX, get


def patch(url, body):
    import urllib.request

    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="PATCH", headers={"content-type": "application/json"})
    urllib.request.urlopen(req)


def test_create_update_and_undo_all(bundle_path, server_url):
    client = UndoableClient(bundle_path, server_url)
    todo = client.call("createTodo", body={"title": "py"})
    tid = todo["data"]["id"]
    assert todo["entry"]["inverse"]["path"] == f"/todos/{tid}"
    client.call("updateTodo", params={"todoId": tid}, body={"title": "changed"})
    result = client.undo_all()
    assert [e["operationId"] for e in result["undone"]] == ["updateTodo", "createTodo"]
    assert result["failed"] == []
    assert get(f"{server_url}/todos/{tid}")[0] == 404


def test_conflict_is_refused_and_force_overrides(bundle_path, server_url):
    agent = UndoableClient(bundle_path, server_url)
    tid = agent.call("createTodo", body={"title": "orig"})["data"]["id"]
    res = agent.call("updateTodo", params={"todoId": tid}, body={"title": "agent"})
    patch(f"{server_url}/todos/{tid}", {"title": "human"})
    with pytest.raises(ConflictError) as err:
        agent.undo(res["entry"])
    assert err.value.conflicts == [{"field": "title", "expected": "agent", "actual": "human"}]
    assert get(f"{server_url}/todos/{tid}")[1]["title"] == "human"
    agent.undo(res["entry"], force=True)
    assert get(f"{server_url}/todos/{tid}")[1]["title"] == "orig"


def test_dependencies_and_cascade(bundle_path, server_url):
    client = UndoableClient(bundle_path, server_url)
    created = client.call("createTodo", body={"title": "parent"})
    comment = client.call("createComment", params={"todoId": created["data"]["id"]}, body={"text": "hi"})
    with pytest.raises(DependencyError):
        client.undo(created["entry"])
    client.undo(created["entry"], cascade=True)
    assert comment["entry"]["status"] == "undone"


def test_id_remap_after_recreate(bundle_path, server_url):
    setup = UndoableClient(bundle_path, server_url)
    tid = setup.call("createTodo", body={"title": "orig"})["data"]["id"]
    session = UndoableClient(bundle_path, server_url)
    session.call("updateTodo", params={"todoId": tid}, body={"title": "edited"})
    session.call("deleteTodo", params={"todoId": tid})
    assert session.undo_all()["failed"] == []
    new_id = session.remap_id("todoId", tid)
    assert new_id != tid
    assert get(f"{server_url}/todos/{new_id}")[1]["title"] == "orig"


def test_restore_children(children_bundle_path, server_url):
    setup = UndoableClient(children_bundle_path, server_url)
    tid = setup.call("createTodo", body={"title": "with comments"})["data"]["id"]
    setup.call("createComment", params={"todoId": tid}, body={"text": "a"})
    agent = UndoableClient(children_bundle_path, server_url)
    agent.call("deleteTodo", params={"todoId": tid})
    agent.undo()
    new_id = agent.remap_id("todoId", tid)
    assert [c["text"] for c in get(f"{server_url}/todos/{new_id}/comments")[1]] == ["a"]


def test_irreversible_gate_and_replays(bundle_path, server_url, tmp_path):
    blocked = UndoableClient(bundle_path, server_url)
    tid = blocked.call("createTodo", body={"title": "x"})["data"]["id"]
    with pytest.raises(IrreversibleOperationError):
        blocked.call("sendReminder", params={"todoId": tid})

    path = str(tmp_path / "journal.jsonl")
    first = UndoableClient(bundle_path, server_url, allow_irreversible=True, store=FileJournalStore(path))
    first.call("sendReminder", params={"todoId": tid})
    restarted = UndoableClient(bundle_path, server_url, allow_irreversible=True, store=FileJournalStore(path))
    with pytest.raises(ReplayBlockedError):
        restarted.call("sendReminder", params={"todoId": tid})
    # A human approval upstream (e.g. the agent framework) is explicit consent.
    assert restarted.call("sendReminder", params={"todoId": tid}, approved=True)["status"] == 202


def test_journal_is_compatible_with_the_typescript_cli(bundle_path, server_url, tmp_path):
    path = str(tmp_path / "shared.jsonl")
    client = UndoableClient(bundle_path, server_url, store=FileJournalStore(path))
    tid = client.call("createTodo", body={"title": "cross-language"})["data"]["id"]
    out = subprocess.run(
        [str(TSX), str(ROOT / "src/cli.ts"), "undo", str(ROOT / "examples/todo-api/openapi.yaml"), "--base-url", server_url, "--journal", path],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={"NO_COLOR": "1", "PATH": __import__("os").environ["PATH"]},
    )
    assert f"#1 createTodo  DELETE /todos/{tid}" in out.stdout, out.stdout + out.stderr
    assert get(f"{server_url}/todos/{tid}")[0] == 404
    assert UndoableClient(bundle_path, server_url, store=FileJournalStore(path)).journal[0]["status"] == "undone"


def test_tool_definitions(bundle_path, server_url):
    client = UndoableClient(bundle_path, server_url)
    tools = {t.name: t for t in tool_definitions(client)}
    assert tools["sendReminder"].needs_approval and "IRREVERSIBLE" in tools["sendReminder"].description
    assert tools["updateTodo"].input_schema["required"] == ["todoId", "body"]
    assert "title" in tools["updateTodo"].input_schema["properties"]["body"]["properties"]
    created = tools["createTodo"].execute(body={"title": "tool"})
    assert created["journal"]["undo"].startswith("DELETE /todos/")
    assert tools["undogen_undo"].execute()["status"] == 204


def test_irreversible_entries_do_not_block_rollback(bundle_path, server_url):
    client = UndoableClient(bundle_path, server_url, allow_irreversible=True)
    tid = client.call("createTodo", body={"title": "reminded"})["data"]["id"]
    client.call("sendReminder", params={"todoId": tid})
    result = client.undo_all()
    assert [f["entry"]["operationId"] for f in result["failed"]] == ["sendReminder"]
    assert [e["operationId"] for e in result["undone"]] == ["createTodo"]
    assert get(f"{server_url}/todos/{tid}")[0] == 404


def test_preview_tool(bundle_path, server_url):
    tools = {t.name: t for t in tool_definitions(UndoableClient(bundle_path, server_url))}
    p = tools["undogen_preview"].execute(tool="updateTodo")
    assert p["undo"] == "PATCH /todos/{todoId} (body: the captured values of the fields sent)"
    assert p["capture"] == "GET /todos/{todoId}" and p["needsApproval"] is False
    assert tools["undogen_preview"].execute(tool="sendReminder")["needsApproval"] is True


def test_restore_grandchildren(projects):
    bundle, url = projects
    setup = UndoableClient(bundle, url)
    p = setup.call("createProject", body={"title": "launch"})["data"]["id"]
    t = setup.call("createTask", params={"projectId": p}, body={"title": "design"})["data"]["id"]
    setup.call("createNote", params={"projectId": p, "taskId": t}, body={"title": "use blue"})
    agent = UndoableClient(bundle, url)
    agent.call("deleteProject", params={"projectId": p})
    agent.undo()
    np, nt = agent.remap_id("projectId", p), agent.remap_id("taskId", t)
    assert [x["title"] for x in get(f"{url}/projects/{np}/tasks")[1]] == ["design"]
    assert [x["title"] for x in get(f"{url}/projects/{np}/tasks/{nt}/notes")[1]] == ["use blue"]


def test_multipart_bodies():
    from email.parser import BytesParser
    from email.policy import HTTP

    from undogen.client import _encode_body

    data, ctype = _encode_body({"caption": "hi", "tags": ["a", "b"], "meta": {"x": 1}, "file": ("a.txt", b"hello", "text/plain")}, "multipart/form-data")
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + data)
    parts = [(p.get_param("name", header="content-disposition"), p.get_filename(), p.get_content()) for p in msg.iter_parts()]
    assert parts == [("caption", None, "hi"), ("tags", None, "a"), ("tags", None, "b"), ("meta", None, '{"x": 1}'), ("file", "a.txt", "hello")]


def test_json_patch_inverse():
    from undogen.client import invert_json_patch

    patch = [
        {"op": "replace", "path": "/title", "value": "new"},
        {"op": "add", "path": "/tags/-", "value": "b"},
        {"op": "add", "path": "/status", "value": "draft"},
        {"op": "move", "from": "/a~1b", "path": "/c"},
    ]
    assert invert_json_patch(patch, {"title": "orig", "tags": ["a"], "a/b": 1}) == [
        {"op": "add", "path": "/title", "value": "orig"},
        {"op": "add", "path": "/tags", "value": ["a"]},
        {"op": "remove", "path": "/status"},
        {"op": "remove", "path": "/c"},
        {"op": "add", "path": "/a~1b", "value": 1},
    ]


def test_example_agent_session(bundle_path, server_url, capsys):
    import runpy

    runpy.run_path(str(ROOT / "examples/python/agent_session.py"), run_name="example").get("main")(bundle_path, server_url)
    out = capsys.readouterr().out
    assert "blocked: sendReminder needs approval (sendReminder was refused)" in out
    assert "rolled back 2 writes, 0 failed" in out


def test_journal_file_is_owner_only(bundle_path, server_url, tmp_path):
    import os
    import stat

    path = str(tmp_path / "j.jsonl")
    UndoableClient(bundle_path, server_url, store=FileJournalStore(path)).call("createTodo", body={"title": "secret"})
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_tools_only_send_declared_headers(bundle_path, server_url):
    import json as _json

    data = _json.load(open(bundle_path))
    for op in data["operations"]:
        if op["id"] == "listTodos":
            op["headerParams"] = [{"name": "X-Tenant", "required": False}]
    sent = []
    client = UndoableClient(data, server_url, headers={"authorization": "Bearer configured"}, before_request=lambda r: sent.append(dict(r.headers)))
    tool = next(t for t in tool_definitions(client) if t.name == "listTodos")
    tool.execute(headers={"authorization": "Bearer agent", "x-tenant": "acme", "cookie": "a=b"})
    assert sent[0]["authorization"] == "Bearer configured" and sent[0]["X-Tenant"] == "acme" and "cookie" not in sent[0]


def test_paired_action_conflict(bundle_path, server_url):
    agent = UndoableClient(bundle_path, server_url)
    tid = agent.call("createTodo", body={"title": "x"})["data"]["id"]
    archived = agent.call("archiveTodo", params={"todoId": tid})
    assert archived["entry"]["check"]["expected"] == {"archived": True, "done": True}
    UndoableClient(bundle_path, server_url).call("unarchiveTodo", params={"todoId": tid})
    with pytest.raises(ConflictError) as err:
        agent.undo(archived["entry"])
    assert err.value.conflicts == [{"field": "archived", "expected": True, "actual": False}]


def test_checkpoints(bundle_path, server_url):
    client = UndoableClient(bundle_path, server_url)
    keep = client.call("createTodo", body={"title": "before"})["data"]["id"]
    cp = client.checkpoint()
    gone = client.call("createTodo", body={"title": "task"})["data"]["id"]
    assert [e["operationId"] for e in client.undo_to(cp)["undone"]] == ["createTodo"]
    assert get(f"{server_url}/todos/{gone}")[0] == 404 and get(f"{server_url}/todos/{keep}")[0] == 200
