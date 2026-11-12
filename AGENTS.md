# AGENTS.md — pi-extensions monorepo

Self-made pi agent extensions, one extension per top-level entry; runtime
loads them via `~/.pi/agent/extensions/` symlinks into this repo. See
README.md for per-extension descriptions, wiring and the
optional-upstream-sync policy.

## Working conventions

- Edit extension sources **in this repo** (never in `~/.pi/agent/extensions/`,
  those are symlinks). Test with `/reload` in a pi session.
- Tests: `PI_TEST_PI_ENTRY=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js node --test .`
  — run before committing. Repo-root `node_modules` symlink provides peer deps;
  re-point it after a pi version bump.
- This repo sets `commit.gpgsign=false` locally (agent shells can't run
  pinentry; global config signs commits elsewhere).
- Vendored forks (`plan-mode/`, `simple-task/`): syncing with
  `@bachi/pi-coder` upstream is OPTIONAL — follow the re-vendor steps in each
  README, never bulk-overwrite the directory.
- Never commit: secrets (`~/.pi/agent/secrets/`), machine-local config, or
  anything under `.pi/`.
- `transcript-viz/` is archived — development stopped 2026-11-12. Don't build
  on it; fix forward only if it breaks loading.
- New single-file UI tweaks go into `ui-polish/` behind the `index.ts`
  aggregator; substantial new extensions get their own top-level directory.
- Image generation lives in `image-gen.ts`: provider-agnostic by intent,
  CodeAPI is just the current backend — add further backends as additional
  providers/models, don't rename back to a vendor name.
