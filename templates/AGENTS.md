# AGENTS.md

## What this project does
Describe what `{{PROJECT_NAME}}` is supposed to do in plain language.

## Stack
List the languages, frameworks, package managers, and tools used here.

## Conventions
- Keep changes scoped to the requested task.
- Run `./verify.sh` before considering work complete.
- Update docs when externally visible behavior changes.
- Prefer small, direct changes over broad refactors.
- Every test creates its own dependencies. No shared mutable state.
- Tests must pass in any order and in parallel (`jest --maxWorkers=100%`).
- Pure functions only in service files. Side effects isolated in adapters.
- No singletons. Pass dependencies as function arguments.
- Time via dependency injection: never use `Date.now()` directly.

## Recommended lint rules
- `no-unused-vars`: error
- `no-empty`: error
- `no-console`: error
- `@typescript-eslint/no-unused-imports`: error

## Module structure
Document the key folders and entry points for this repo.

## Do NOT
- Edit secrets, production config, or deployment files unless the task requires it.
- Make unrelated fixes while working on the current task.
