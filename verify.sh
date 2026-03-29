#!/usr/bin/env bash
set -euo pipefail

if [ -f package.json ]; then
  scripts="$(npm run 2>/dev/null || true)"
  has_script() { printf '%s\n' "$scripts" | grep -qE "^[[:space:]]+$1$"; }
  if has_script verify; then
    npm run verify
    exit 0
  fi
  ran=0
  if has_script lint; then npm run lint; ran=1; fi
  if has_script typecheck; then npm run typecheck; ran=1; fi
  if has_script test; then npm test; ran=1; fi
  if has_script build; then npm run build; ran=1; fi
  if [ "$ran" -eq 1 ]; then exit 0; fi
fi

if [ -f pyproject.toml ]; then
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
  if command -v pytest >/dev/null 2>&1; then pytest; fi
  exit 0
fi

echo "verify.sh: no repo-specific verification configured yet. Edit this file for agentloop."
