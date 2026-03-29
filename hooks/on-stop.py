#!/usr/bin/env python3
"""Stop hook: mark the current Claude session as stopped."""
import json
from pathlib import Path

status_file = Path('.agentloop/session-status.json')
status_file.parent.mkdir(parents=True, exist_ok=True)
status_file.write_text(json.dumps({"status": "stopped"}))
