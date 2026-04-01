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
- Pure functions only in service files. Side effects isolated in adapters.
- No singletons. Pass dependencies as function arguments.
- Time via dependency injection: never use `Date.now()` directly.
- If a behavior must happen, enforce it in code (types, hooks, tests, `verify.sh`), not in this document. Prose rules are the weakest enforcement.
- Changes to persisted types or shared interfaces must be additive-only by default. Never remove or rename a field without a migration path.
- Every stateful artifact (files, caches, logs) needs a max size, cleanup rule, and owner. If it grows unbounded, it's a bug.

## Test conventions
- Tests must pass in any order and in parallel (`jest --maxWorkers=100%`). If they do not, remove hidden shared state instead of lowering worker count.
- Each test creates its own dependencies. No shared databases, files, ports, env vars, or mocks across tests.
- Use unique temp directories, ephemeral ports, or in-memory stores when tests need state. Clean them up in `afterEach`.
- Call `jest.restoreAllMocks()` in `afterEach`.
- Seed randomness or replace it with fixed fixtures. Flaky tests are broken.
- Keep unit tests fast. Network, API, or real-service coverage belongs in integration tests that run only on merge or in a dedicated integration lane.

## Recommended lint rules
- `no-unused-vars`: error
- `no-empty`: error
- `no-console`: error
- `@typescript-eslint/no-unused-imports`: error

## Module structure
Document the key folders and entry points for this repo.

## Do NOT
- Edit secrets, production config, or deployment files unless the task requires it.
- Add or import new npm dependencies unless the task explicitly requires it.
- Make unrelated fixes while working on the current task.
