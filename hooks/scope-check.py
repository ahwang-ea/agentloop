#!/usr/bin/env python3
"""PreToolUse hook: blocks file edits outside the current task's scope.

Reads the task scope from .agentloop/current-scope.json (written by orchestrator).
If the file being edited isn't in the editable list, exits with code 2 to block.
"""
import json
import sys
import fnmatch
from pathlib import Path

def main():
    input_data = json.loads(sys.stdin.read())
    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    if not file_path:
        sys.exit(0)  # No file path — allow (not a file edit)

    scope_file = Path(".agentloop/current-scope.json")
    if not scope_file.exists():
        sys.exit(0)  # No scope defined — allow all (manual mode)

    scope = json.loads(scope_file.read_text())
    editable = scope.get("editableFiles", [])
    forbidden = scope.get("forbiddenFiles", [])

    # Check forbidden first
    for pattern in forbidden:
        if fnmatch.fnmatch(file_path, pattern):
            print(json.dumps({"error": f"BLOCKED: {file_path} is in forbidden scope"}))
            sys.exit(2)

    # Check editable
    for pattern in editable:
        if fnmatch.fnmatch(file_path, pattern):
            sys.exit(0)  # Allowed

    # Not in any editable pattern — block
    print(json.dumps({"error": f"BLOCKED: {file_path} is outside task scope. Editable: {editable}"}))
    sys.exit(2)

if __name__ == "__main__":
    main()
