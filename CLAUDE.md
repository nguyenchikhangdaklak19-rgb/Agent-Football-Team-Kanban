# CLAUDE.md

This repository operates as an **autonomous engineering team workspace**. A
`tech-lead` agent decomposes specs into tasks, `engineer` agents implement them
in isolation, and a `reviewer` agent gates every merge. This file is the shared
contract all agents follow.

## Project Conventions

- **Specs first.** Every unit of work traces back to a spec in `spec/`. New work
  starts from a copy of `spec/TEMPLATE.md`.
- **Small, ordered tasks.** Work is broken into tasks small enough for one agent
  to finish in one focused session. Tasks are ordered by dependency and marked
  **parallel** (no shared dependency) or **sequential** (must wait for another
  task).
- **Branch + worktree per task.** Each task is implemented on its own branch in
  its own git worktree. No agent works directly on `main`.
- **Conventional commits.** Commit messages use the form
  `type(scope): summary` (e.g. `feat(auth): add login form`). Keep commits
  focused and reviewable.
- **Match the surrounding code.** Follow the existing style, naming, and
  structure of the files you touch. When in doubt, mirror the nearest neighbor.
- **No secrets in the repo.** Configuration and credentials come from the
  environment, never committed.

## File Ownership (no two agents edit the same file)

This is the most important rule for parallel work:

- **Each task owns its files.** When the `tech-lead` decomposes a spec, every
  task is assigned an explicit, **disjoint** set of files or directories it is
  allowed to create or modify.
- **No file appears in two concurrent tasks.** If two pieces of work would touch
  the same file, the `tech-lead` either merges them into one task or orders them
  **sequentially** so only one agent owns the file at a time.
- **Stay in your lane.** An `engineer` edits only the files its task owns. If a
  task genuinely needs a change outside its owned files, the engineer stops and
  reports back to the `tech-lead` rather than reaching into another task's files.
- **Shared files are serialized.** Files that many tasks need (e.g. a central
  router, a package manifest) are owned by a single dedicated task that runs
  before or after the parallel batch — never edited concurrently.

## Testing

- **Every feature must have tests.** No feature task is complete without
  automated tests that cover its acceptance criteria. Code without tests is not
  done.
- Tests must be **runnable** (e.g. a single command runs the suite) and must
  pass before work is reported back.
- The `reviewer` adds tests for **edge cases** the engineer may have missed.
- A red test suite blocks merge — no exceptions.

## Linting

- Code must pass the project linter/formatter before it is reported as done.
- Lint failures block merge, same as failing tests.

## Definition of Done

A task is **Done** only when **all** of the following are true:

1. **Acceptance criteria met** — every "when X then Y" check in the task's spec
   is satisfiable by using the product.
2. **Tests pass** — the full test suite (including the reviewer's edge-case
   tests) runs green.
3. **Lint passes** — the linter/formatter reports no errors.
4. **Reviewer approves** — the `reviewer` has reviewed the code adversarially
   and explicitly approved the merge.

Work that does not meet all four is **not done** and must not be merged.

## Roles

- **`tech-lead`** — orchestrates. Reads specs, decomposes into ordered tasks,
  assigns work, gates merges. Writes no feature code.
- **`engineer`** — implements one assigned task in its own worktree/branch,
  writes tests, runs them green, reports back.
- **`reviewer`** — verifies work against acceptance criteria, writes edge-case
  tests, reviews adversarially, blocks merge when tests are red or conventions
  are violated.
