#!/usr/bin/env bash
set -euo pipefail

progressive=0
merge_mode="${AGENTLOOP_MERGE_CHECK:-0}"
files=()
test_args=(--maxWorkers=100%)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --progressive) progressive=1 ;;
    --merge) merge_mode=1 ;;
    *) files+=("$1") ;;
  esac
  shift
done

detect_doc_base() {
  if [ -n "${AGENTLOOP_DOC_BASE:-}" ]; then
    printf '%s\n' "$AGENTLOOP_DOC_BASE"
    return 0
  fi
  for candidate in main master origin/main origin/master; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  local remote_head
  remote_head="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  [ -n "$remote_head" ] && printf '%s\n' "$remote_head"
}

warn_doc_freshness() {
  [ "$merge_mode" = "1" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  local base_ref merge_base changed code_changed count
  base_ref="$(detect_doc_base || true)"
  [ -n "$base_ref" ] || return 0
  merge_base="$(git merge-base HEAD "$base_ref" 2>/dev/null || true)"
  [ -n "$merge_base" ] || return 0
  changed="$(git diff --name-only "$merge_base" HEAD -- 2>/dev/null || true)"
  [ -n "$changed" ] || return 0
  code_changed="$(printf '%s\n' "$changed" | grep -E '^src/.*\.ts$' || true)"
  [ -n "$code_changed" ] || return 0
  printf '%s\n' "$changed" | grep -qx 'AGENTS.md' && return 0
  printf '%s\n' "$changed" | grep -qx 'ARCHITECTURE.md' && return 0
  count="$(printf '%s\n' "$code_changed" | sed '/^$/d' | wc -l | tr -d ' ')"
  echo "WARNING: doc-freshness: ${count} src/*.ts files changed without AGENTS.md or ARCHITECTURE.md updates"
}

run_checks() {
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
    if [ "$merge_mode" = "1" ]; then
      if [ "${AGENTLOOP_SKIP_DEPCHECK:-0}" != "1" ] && command -v npx >/dev/null 2>&1; then npx depcheck --ignores="@types/*" || exit 1; fi
      if grep -rnE '^\s*//\s*(const|let|var|function|class|if|for|while|switch|return|import|export|[A-Za-z0-9_$]+\s*[({=])' src/ \
        | grep -v 'TODO\|FIXME\|HACK\|NOTE\|eslint'; then
        echo "ERROR: commented-out code found"
        exit 1
      fi
      warn_doc_freshness
    fi
  fi
}

if [ "$progressive" -eq 1 ] && [ -f package.json ]; then
  scripts="$(npm run 2>/dev/null || true)"
  has_script() { printf '%s\n' "$scripts" | grep -qE "^[[:space:]]+$1$"; }
  ran=0
  if has_script typecheck; then npm run typecheck; ran=1; fi
  if has_script test && [ "${#files[@]}" -gt 0 ]; then npm test -- --findRelatedTests "${files[@]}" --passWithNoTests "${test_args[@]}"; ran=1; fi
  if [ "$merge_mode" = "1" ]; then
    if has_script test; then npm test -- "${test_args[@]}"; ran=1; fi
    if has_script lint; then npm run lint; ran=1; fi
  fi
  if [ "$ran" -eq 1 ]; then run_checks; exit 0; fi
fi

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
    if has_script test; then npm test -- "${test_args[@]}"; ran=1; fi
    if has_script build; then npm run build; ran=1; fi
  fi
  if [ "$ran" -eq 1 ]; then run_checks; exit 0; fi
fi

if [ -f pyproject.toml ]; then
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
  if command -v pytest >/dev/null 2>&1; then pytest; fi
  run_checks
  exit 0
fi

run_checks
echo "verify.sh: no repo-specific verification configured yet. Edit this file for agentloop."
