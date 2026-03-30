#!/usr/bin/env bash
set -euo pipefail

ran=0
if [ -f package.json ]; then
  scripts="$(npm run 2>/dev/null || true)"
  has_script() { printf '%s\n' "$scripts" | grep -qE "^[[:space:]]+$1$"; }
  if has_script verify; then
    npm run verify
    ran=1
  else
    if has_script lint; then npm run lint; ran=1; fi
    if has_script typecheck; then npm run typecheck; ran=1; fi
    if has_script test; then npm test; ran=1; fi
    if has_script build; then npm run build; ran=1; fi
  fi
fi

if [ -d src ]; then
  PREFIX="${AGENTLOOP_PREFIX:-al-}"
  if grep -rnE 'TODO|FIXME|HACK' src/ \
    | grep -v "TODO(${PREFIX}" \
    | grep -v "FIXME(${PREFIX}" \
    | grep -v "HACK(${PREFIX}" \
    | grep -v node_modules; then
    echo "ERROR: Found TODO/FIXME/HACK without task ID. Use: // TODO(${PREFIX}NNN): description"
    exit 1
  fi
  if [ "${AGENTLOOP_MERGE_CHECK:-0}" = "1" ]; then
    if command -v npx >/dev/null 2>&1; then npx depcheck --ignores="@types/*" || exit 1; fi
    if grep -rnE '^\s*//\s*(const|let|var|function|class|if|for|while|switch|return|import|export|[A-Za-z0-9_$]+\s*[({=])' src/ \
      | grep -v 'TODO\|FIXME\|HACK\|NOTE\|eslint'; then
      echo "ERROR: commented-out code found"
      exit 1
    fi
  fi
fi

if [ "$ran" -eq 1 ]; then exit 0; fi

if [ -f pyproject.toml ]; then
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
  if command -v pytest >/dev/null 2>&1; then pytest; fi
  exit 0
fi

echo "verify.sh: no repo-specific verification configured yet. Edit this file for {{PROJECT_NAME}}."
