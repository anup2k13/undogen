"""Inspect and roll back journals from Python, without Node:

    python -m undogen journal --journal .undogen/journal.jsonl
    python -m undogen undo undogen.json --base-url https://api.example.com --journal .undogen/journal.jsonl [--seq N | --after N | --all] [--force] [--cascade]
    python -m undogen journal --journal .undogen/journal.jsonl --compact

The bundle comes from `undogen compile spec.yaml -o undogen.json`. Journals written by either runtime work.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional

from .client import FileJournalStore, UndoableClient, UndogenError
from .tools import describe_entry


def _headers(values: Optional[List[str]]) -> dict:
    out = {}
    for h in values or []:
        name, sep, value = h.partition(":")
        if not sep or not name.strip():
            raise SystemExit(f'Bad --header "{h}", expected "name: value"')
        out[name.strip()] = value.strip()
    return out


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m undogen", description="Inspect and roll back undogen journals.")
    sub = parser.add_subparsers(dest="command", required=True)

    j = sub.add_parser("journal", help="show a journal")
    j.add_argument("--journal", required=True)
    j.add_argument("--json", action="store_true")
    j.add_argument("--compact", action="store_true", help="rewrite it with the latest version of each entry")

    u = sub.add_parser("undo", help="undo entries of a journal")
    u.add_argument("bundle", help="undogen.json from `undogen compile`")
    u.add_argument("--base-url", required=True)
    u.add_argument("--journal", required=True)
    u.add_argument("--header", action="append", help='"name: value" (repeatable)')
    which = u.add_mutually_exclusive_group()
    which.add_argument("--seq", type=int, help="undo this entry (default: the most recent one)")
    which.add_argument("--after", type=int, help="undo everything after this entry (a checkpoint)")
    which.add_argument("--all", action="store_true", help="undo everything, newest first")
    u.add_argument("--force", action="store_true", help="undo even if someone changed the data since")
    u.add_argument("--cascade", action="store_true", help="undo dependent entries first")

    args = parser.parse_args(argv)
    store = FileJournalStore(args.journal)

    if args.command == "journal":
        if args.compact:
            r = store.compact()
            print(f"  {args.journal}: {r['before']} lines -> {r['after']} entries")
            return 0
        entries = store.load()
        if args.json:
            print(json.dumps(entries, indent=2))
            return 0
        if not entries:
            print("  (empty journal)")
        for e in entries:
            d = describe_entry(e)
            print(f"  #{str(d['seq']).ljust(4)} {d['status'].ljust(9)} {d['operationId'].ljust(28)} {d['request'].ljust(40)} ↺ {d['undo'] or '(none)'}")
            if e.get("undoError"):
                print(f"        {e['undoError']}")
        return 0

    if not os.path.exists(args.journal):
        print(f"error: no journal at {args.journal}", file=sys.stderr)
        return 2
    client = UndoableClient(args.bundle, args.base_url, store=store, headers=_headers(args.header))
    if args.all or args.after is not None:
        result = client.undo_all(force=args.force, after=args.after)
        for e in result["undone"]:
            print(f"  ↺ #{e['seq']} {e['operationId']}  {describe_entry(e)['undo']}")
        for f in result["failed"]:
            print(f"  ✗ #{f['entry']['seq']} {f['entry']['operationId']}: {f['error']}")
        return 1 if result["failed"] else 0
    try:
        target = args.seq if args.seq is not None else next((e for e in reversed(client.journal) if e["status"] != "undone"), None)
        if target is None:
            print("  nothing to undo")
            return 0
        client.undo(target, force=args.force, cascade=args.cascade)
        e = next(x for x in client.journal if x["seq"] == (target if isinstance(target, int) else target["seq"]))
        print(f"  ↺ #{e['seq']} {e['operationId']}  {describe_entry(e)['undo']}")
        return 0
    except UndogenError as err:
        print(f"  ✗ {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
