import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TSX = ROOT / "node_modules" / ".bin" / "tsx"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server_url():
    """The demo Todo API (with its two planted reversibility bugs), started with tsx."""
    port = _free_port()
    proc = subprocess.Popen([str(TSX), str(ROOT / "examples/todo-api/server.ts"), str(port)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/todos", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("demo server did not start")
    yield url
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture(scope="session")
def bundle_path(tmp_path_factory):
    """Compile the demo spec with the real CLI, so Python uses exactly what TypeScript compiled."""
    out = tmp_path_factory.mktemp("bundle") / "undogen.json"
    subprocess.run([str(TSX), str(ROOT / "src/cli.ts"), "compile", str(ROOT / "examples/todo-api/openapi.yaml"), "-o", str(out)], cwd=ROOT, check=True)
    return str(out)


@pytest.fixture(scope="session")
def children_bundle_path(tmp_path_factory):
    out = tmp_path_factory.mktemp("bundle") / "undogen-children.json"
    subprocess.run(
        [str(TSX), str(ROOT / "src/cli.ts"), "compile", str(ROOT / "examples/todo-api/openapi.yaml"), "--restore-children", "-o", str(out)],
        cwd=ROOT,
        check=True,
    )
    return str(out)


def get(url: str):
    try:
        with urllib.request.urlopen(url) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None
