#!/usr/bin/env python3
"""mistakes-memory path resolver - single source of truth for the log location.

Maps the current working directory to its per-directory mistake log:

    ~/.pi/agent/mistakes/<cwd-key>/mistakes.md

<cwd-key> mirrors pi's session-storage project-key convention: the absolute
cwd with '/' -> '-' and wrapped in leading/trailing '--'. Example:

    /Users/pabloperaza/LLMs  ->  --Users-pabloperaza-LLMs--

No git dependency: the key is derived from cwd alone (decision Q6b). The log
lives outside any repo so it is never committed (decision Q5).

Run from the skill with: python3 <skill-dir>/scripts/mistakes_path.py [--json]

Options:
  --cwd <path>   Override the cwd to key on (default: os.getcwd()).
  --no-create    Do not create the parent directory (default: create it).
  --json         Emit a JSON payload instead of the bare path.
"""

import json
import os
import sys
from pathlib import Path

def mistakes_root() -> Path:
    """Root of the mistake store. Honors PI_MISTAKES_ROOT for test isolation;
    defaults to ~/.pi/agent/mistakes."""
    override = os.environ.get("PI_MISTAKES_ROOT")
    if override:
        return Path(override)
    return Path.home() / ".pi" / "agent" / "mistakes"


def cwd_key(cwd: str) -> str:
    """Project-key label for a cwd: '/A/b' -> '--A-b--'.

    The key is a directory label, never reversed back to a path, so a literal
    '-' inside a segment is accepted (KISS, decision Q6b).
    """
    stripped = cwd.strip("/")
    joined = stripped.replace("/", "-") if stripped else ""
    return f"--{joined}--"


def mistakes_file(cwd: str) -> Path:
    return mistakes_root() / cwd_key(cwd) / "mistakes.md"


def main(argv: list[str]) -> int:
    cwd = os.getcwd()
    create = True
    as_json = "--json" in argv
    if "--no-create" in argv:
        create = False
    if "--cwd" in argv:
        i = argv.index("--cwd")
        if i + 1 >= len(argv):
            print("mistakes_path: --cwd requires a value", file=sys.stderr)
            return 2
        cwd = argv[i + 1]

    path = mistakes_file(cwd)
    if create:
        path.parent.mkdir(parents=True, exist_ok=True)

    if as_json:
        payload = {
            "path": str(path),
            "dir": str(path.parent),
            "cwd": cwd,
            "key": cwd_key(cwd),
            "exists": path.exists(),
        }
        print(json.dumps(payload))
    else:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
