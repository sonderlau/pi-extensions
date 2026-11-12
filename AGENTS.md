# AGENTS.md — pi-extensions monorepo

Self-made pi agent extensions; runtime loads them via `~/.pi/agent/extensions/`
symlinks into this repo. See README.md for layout, wiring and the
optional-upstream-sync policy.

## Working conventions

- Edit extension sources **in this repo** (never in `~/.pi/agent/extensions/`,
  those are symlinks). Test with `/reload` in a pi session.
- Tests: `PI_TEST_PI_ENTRY=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js node --test extensions/`
  — run before committing. Repo-root `node_modules` symlink provides peer deps;
  re-point it after a pi version bump.
- This repo sets `commit.gpgsign=false` locally (agent shells can't run
  pinentry; global config signs commits elsewhere).
- Vendored forks (`extensions/plan-mode/`, `extensions/simple-task/`):
  syncing with `@bachi/pi-coder` upstream is OPTIONAL — follow the re-vendor
  steps in each README, never bulk-overwrite the directory.
- Never commit: secrets (`~/.pi/agent/secrets/`), machine-local config, or
  anything under `.pi/`.
- `extensions/transcript-viz/` is WIP — expect active churn there.
