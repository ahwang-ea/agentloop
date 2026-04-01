#!/usr/bin/env python3
"""PreToolUse hook: blocks file edits outside the current task's scope.

Reads the task scope from .agentloop/current-scope.json (written by orchestrator).
If the file being edited isn't in the editable list, exits with code 2 to block.
"""
import fnmatch
import json
import sys
from pathlib import Path


def fail(message: str):
    print(json.dumps({"error": message}))
    sys.exit(2)


def candidates(file_path: str):
    raw = file_path.replace("\\", "/")
    values = {raw, raw.lstrip("./")}
    path = Path(file_path)
    if path.is_absolute():
        try:
            values.add(path.resolve().relative_to(Path.cwd().resolve()).as_posix())
        except ValueError:
            pass
        values.add(path.resolve().as_posix())
    else:
        values.add(path.as_posix().lstrip("./"))
    return [value for value in values if value]


def matches(paths, patterns):
    return any(fnmatch.fnmatch(path, pattern) for path in paths for pattern in patterns)


def main():
    try:
        input_data = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        fail(f"BLOCKED: invalid hook input ({exc})")

    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    scope_file = Path(".agentloop/current-scope.json")
    if not scope_file.exists():
        sys.exit(0)

    try:
        scope = json.loads(scope_file.read_text())
    except json.JSONDecodeError as exc:
        fail(f"BLOCKED: invalid scope file {scope_file} ({exc})")

    editable = scope.get("editableFiles", [])
    forbidden = scope.get("forbiddenFiles", [])
    paths = candidates(file_path)
    phase = scope.get("phase", "write")
    task_id = scope.get("taskId", "unknown task")

    if matches(paths, forbidden):
        fail(f"BLOCKED: {file_path} is forbidden for {task_id} during {phase}")
    if matches(paths, editable):
        sys.exit(0)
    fail(f"BLOCKED: {file_path} is outside task scope for {task_id} during {phase}. Editable: {editable}")


if __name__ == "__main__":
    main()
