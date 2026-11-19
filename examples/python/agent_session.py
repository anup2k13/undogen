"""An agent session in Python: make some writes, get blocked on an irreversible one, roll back.

    npx undogen compile examples/todo-api/openapi.yaml -o undogen.json
    npx tsx examples/todo-api/server.ts 4010 &
    python examples/python/agent_session.py undogen.json http://localhost:4010
"""

import sys

from undogen import ConflictError, IrreversibleOperationError, UndoableClient


def main(bundle: str, base_url: str) -> None:
    approvals = []

    def ask_human(op, plan, call, replay_of):
        approvals.append(op["id"])
        return False  # a real app would ask someone; this demo always says no

    client = UndoableClient(bundle, base_url, allow_irreversible=ask_human)

    todo = client.call("createTodo", body={"title": "Ship the Python client"})
    todo_id = todo["data"]["id"]
    client.call("updateTodo", params={"todoId": todo_id}, body={"done": True})
    print(f"created {todo_id} and marked it done")

    try:
        client.call("sendReminder", params={"todoId": todo_id})
    except IrreversibleOperationError as err:
        print(f"blocked: {err.operation_id} needs approval ({approvals[-1]} was refused)")

    for entry in client.journal:
        undo = entry["inverse"]
        print(f"  #{entry['seq']} {entry['operationId']:<12} undo: {undo['method'].upper() + ' ' + undo['path'] if undo else '—'}")

    try:
        result = client.undo_all()
    except ConflictError as err:  # someone else changed the todo in the meantime
        print(f"refused to overwrite a concurrent change: {err}")
        return
    print(f"rolled back {len(result['undone'])} writes, {len(result['failed'])} failed")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
