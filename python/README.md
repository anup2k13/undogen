# undogen for Python

Journaled, undoable API calls for Python agents. The plans come from the
[undogen](https://github.com/anup2k13/undogen) compiler, so compile once and use them here:

```bash
npx undogen compile openapi.yaml -o undogen.json
pip install undogen                    # no dependencies
pip install "undogen[langchain]"       # LangChain / LangGraph tools
pip install "undogen[openai-agents]"   # OpenAI Agents SDK tools
```

```python
from undogen import UndoableClient, FileJournalStore

client = UndoableClient(
    "undogen.json",
    "https://sandbox.example.com",
    headers={"authorization": f"Bearer {token}"},
    allow_irreversible=lambda op, plan, call, replay_of: ask_human(op["id"]),
    store=FileJournalStore(".undogen/journal.jsonl"),  # same format as the TypeScript client and `undogen undo`
)

todo = client.call("createTodo", body={"title": "Ship it"})
client.call("updateTodo", params={"todoId": todo["data"]["id"]}, body={"done": True})
client.undo()        # newest first; refuses if someone else changed the data since (ConflictError)
client.undo_all()    # saga-style rollback
```

Tools for agent frameworks:

```python
from undogen.adapters.langchain import to_langchain_tools
from undogen.adapters.openai_agents import to_openai_agents_tools   # irreversible tools use needs_approval

tools = to_langchain_tools(client)   # one tool per operation + undogen_undo, undogen_undo_all, undogen_journal
```

Bodies can be JSON, form-encoded or multipart (pass files as `(filename, bytes, content_type)` tuples).
