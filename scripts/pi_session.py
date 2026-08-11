#!/usr/bin/env python3
"""pi session working directory - single source of truth for the pablo-* skills.

Resolves where the current pi session keeps its working files:

- persistent session: <session-storage>/<project>/<session>.files/ - sibling of
  the session .jsonl, derived from PI_SESSION_FILE
- ephemeral session:  /tmp/pi/session/<PI_SESSION_ID>

Run from any skill with: python3 <skill-dir>/scripts/pi_session.py [--json]
"""

import json
import os
import sys
from pathlib import Path

EPHEMERAL_ROOT = Path("/tmp/pi/session")


def resolve_session_dir(session_file: str | None, session_id: str | None) -> Path:
    """Working directory for the current pi session.

    session_file: value of PI_SESSION_FILE ("" is treated as absent - pi sets
    it to "" in RPC mode when no session file exists).
    session_id: value of PI_SESSION_ID.

    Raises ValueError when neither is present.
    """
    if session_file:
        f = Path(session_file)
        return f.parent / (f.stem + ".files")
    if session_id:
        return EPHEMERAL_ROOT / session_id
    raise ValueError(
        "PI_SESSION_FILE and PI_SESSION_ID are both unset: not running inside pi"
    )


def main(argv: list[str]) -> int:
    session_file = os.environ.get("PI_SESSION_FILE")
    session_id = os.environ.get("PI_SESSION_ID")
    try:
        session_dir = resolve_session_dir(session_file, session_id)
    except ValueError as e:
        print(f"pi_session: {e}", file=sys.stderr)
        return 2
    session_dir.mkdir(parents=True, exist_ok=True)
    if "--json" in argv:
        payload = {
            "session_dir": str(session_dir),
            "session_id": session_id,
            "session_file": session_file,
            "storage_dir": str(session_dir.parent) if session_file else None,
            "ephemeral": not bool(session_file),
        }
        print(json.dumps(payload))
    else:
        print(session_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
