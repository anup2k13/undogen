"""The TypeScript and Python runtimes write the same journal for the same session.

A journal written by one runtime is undone by the other (`undogen undo` or
`python -m undogen undo`), so their entries must agree field by field: inverse
requests, conflict checks, created ids, statuses and (minimal journals) which
values are hashed.
"""
import json
import re
import subprocess

import pytest

from undogen import FileJournalStore, UndoableClient

from .conftest import ROOT, TSX, todo_server

TRANSPORT_HEADERS = {"connection", "keep-alive", "date"}


def python_session(bundle_path, url, journal, detail):
    c = UndoableClient(bundle_path, url, store=FileJournalStore(journal), journal_detail=detail)
    t = c.call("createTodo", body={"title": "Grüße", "tags": ["a"]})["data"]["id"]
    c.call("updateTodo", params={"todoId": t}, body={"title": "changed", "done": True})
    c.call("replaceTodo", params={"todoId": t}, body={"title": "replaced"})
    c.call("archiveTodo", params={"todoId": t})
    cm = c.call("createComment", params={"todoId": t}, body={"text": "hi"})["data"]["id"]
    c.call("deleteComment", params={"todoId": t, "commentId": cm})
    t2 = c.call("createTodo", body={"title": "second"})["data"]["id"]
    c.call("deleteTodo", params={"todoId": t2})
    c.undo_all()


def python_children_session(bundle_path, url, journal, detail):
    c = UndoableClient(bundle_path, url, store=FileJournalStore(journal), journal_detail=detail)
    t = c.call("createTodo", body={"title": "with comments"})["data"]["id"]
    c.call("createComment", params={"todoId": t}, body={"text": "first"})
    c.call("createComment", params={"todoId": t}, body={"text": "second"})
    c.call("deleteTodo", params={"todoId": t})
    c.undo_all()


def normalized(journal):
    """Entries with what legitimately differs between two runs (session, times, salted hashes, transport) taken out."""
    out = []
    for line in open(journal, encoding="utf-8"):
        entry = json.loads(line)
        text = json.dumps(entry, ensure_ascii=False).replace(entry["session"], "SESSION")
        text = re.sub(r'"[0-9a-f]{32}(?:[0-9a-f]{32})?"', '"HASH"', text)  # salted with the session
        text = re.sub(r'"\d{4}-\d\d-\d\dT[^"]+"', '"TIME"', text)

        def clean(x):
            if isinstance(x, dict):
                return {k: clean(v) for k, v in x.items() if v is not None and k.lower() not in TRANSPORT_HEADERS}
            if isinstance(x, list):
                return [clean(v) for v in x]
            return x

        out.append(clean(json.loads(text)))
    return out


@pytest.mark.parametrize("detail", ["full", "minimal"])
def test_typescript_and_python_write_the_same_journal(bundle_path, tmp_path, detail):
    ts_journal, py_journal = str(tmp_path / "ts.jsonl"), str(tmp_path / "py.jsonl")
    with todo_server() as url:
        subprocess.run([str(TSX), str(ROOT / "test/fixtures/parity-session.ts"), url, ts_journal, detail], cwd=ROOT, check=True)
    with todo_server() as url:
        python_session(bundle_path, url, py_journal, detail)
    ts, py = normalized(ts_journal), normalized(py_journal)
    assert len(ts) == len(py) == 16  # 8 calls, each saved again when undone
    for a, b in zip(ts, py):
        assert a == b, f"entry #{a.get('seq')} ({a.get('operationId')}) differs"


@pytest.mark.parametrize("detail", ["full", "minimal"])
def test_child_restore_and_id_remap_match(children_bundle_path, tmp_path, detail):
    ts_journal, py_journal = str(tmp_path / "ts.jsonl"), str(tmp_path / "py.jsonl")
    with todo_server() as url:
        subprocess.run([str(TSX), str(ROOT / "test/fixtures/parity-session.ts"), url, ts_journal, detail, "children"], cwd=ROOT, check=True)
    with todo_server() as url:
        python_children_session(children_bundle_path, url, py_journal, detail)
    ts, py = normalized(ts_journal), normalized(py_journal)
    assert [e["status"] for e in ts[-4:]] == ["undone"] * 4
    assert len(ts) == len(py) == 8
    for a, b in zip(ts, py):
        assert a == b, f"entry #{a.get('seq')} ({a.get('operationId')}) differs"


def test_number_ids_hash_like_javascript():
    from undogen.client import _body_refs, _js_str, _ref_hash

    assert [_js_str(v) for v in (12345.0, 12345, 1.5, True, None, "x")] == ["12345", "12345", "1.5", "true", "null", "x"]
    assert _ref_hash("12345", "s") in _body_refs({"boardId": 12345.0}, "s")  # the JavaScript form (plus older str() forms)
