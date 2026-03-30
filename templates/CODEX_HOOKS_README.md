# Codex hooks

This repo scaffolds `.codex/hooks.json` with two hooks:
- `SessionStart` prints `AGENTS.md` and `ARCHITECTURE.md` so Codex starts with local repo guidance.
- `Stop` runs `./verify.sh` and `.agentloop/hooks/on-stop.py` after a write session completes.

Notes:
- Codex hook JSON does not support comments, so this file documents the intent.
- Codex currently intercepts Bash-oriented hooks more reliably than direct file edits.
- Because of that limitation, agentloop enforces Codex file scope in the orchestrator by checking the post-session diff and reverting out-of-scope files.
- `verify.sh` uses `AGENTLOOP_PREFIX` for task-tagged TODOs and `AGENTLOOP_MERGE_CHECK=1` for merge-only checks.
