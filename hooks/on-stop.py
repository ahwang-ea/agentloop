#!/usr/bin/env python3
"""Stop hook: remove the deprecated session status artifact."""
import sys
from pathlib import Path

status_file = Path('.agentloop/session-status.json')


def main():
    if not status_file.exists():
        return
    try:
        status_file.unlink()
    except OSError as exc:
        print(f"agentloop: failed to remove {status_file}: {exc}", file=sys.stderr)


if __name__ == '__main__':
    main()
