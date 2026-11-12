# pi-plan-mode

Vendored `plan-mode` extension from `@bachi/pi-coder` 2.5.6, plus the personal
plan-review overlay UI (scrollable plan view, `L123:` line comments, clickable
buttons with double-confirm).

## Why vendored

The overlay used to work by overwriting `review-ui.ts` inside the installed
npm package at every startup. Upstream 2.5.6 deleted that seam and switched
approval to a plain `ui.select`. A separate extension cannot replace that
dialog through any public hook, so the customized plan-mode lives here as a
vendored copy instead.

## What's frozen vs auto-updating

- **Frozen**: only this `extensions/plan-mode/` directory (plus the tiny
  `sandbox-mode.ts`, which is a `globalThis` singleton and stays compatible
  with upstream's copy).
- **Auto-updating**: pi itself and every other pi-coder extension — settings
  excludes `!extensions/plan-mode/**` from the npm package and loads this
  local package instead.

## Re-vendor procedure (when you want upstream's newer plan-mode)

1. `diff` the new `extensions/plan-mode` against this one; copy the new files over.
2. Re-apply the review integration:
   - `index.ts`: import `showPlanReview`/`PlanReviewResult`, the
     `ApprovalContext` + `resolvePlanApproval` block after the `CHOICE_*`
     constants, and the `const approval = await resolvePlanApproval(ctx, plan)`
     verdict branch inside `exit_plan_mode` (reject / revise / doc-only /
     execute + `formatApprovalNotes(notes)`).
   - `plan-text.ts`: `buildRevisionMessage` + `formatApprovalNotes`.
   - Keep `review-ui.ts` (ours), `review-lines.ts(.test.ts)`, `sandbox-mode.ts`.
3. `node --test extensions/plan-mode/` (uses the `node_modules` symlink to the
  active pi release).
4. Restart pi.

## 计划文件

批准 `exit_plan_mode` 后，扩展会把审阅的 Markdown 原文直接保存到项目内
`.pi/plans/<date>-<slug>.md`，并将同一份快照交给实施流程；保存失败不会离开只读模式。
旧会话中尚未完成的模型写文件步骤不会被信任，需要重新审批。

`/plan` 不带参数仍切换 plan mode。计划库命令：

- `/plan list`：列出项目计划。
- `/plan show [file.md]`：查看文件，省略文件名时选列表末项。
- `/plan edit [file.md]`：在宿主编辑器修改计划；检测到并发变更时可另存、重载或取消。
- `/plan implement [file.md]`：重新审阅文件内容；仅当审批期间文件未改变才实施该快照。
- `/plan export <file.md> <project-relative-destination>`：在项目内新建导出副本，不覆盖已有文件。

编辑后的计划不会自动实施，必须重新运行 `/plan implement` 并批准。计划操作不允许通过
路径遍历或项目内符号链接访问计划目录之外的文件。

## 快速测试审阅界面

修改后先在 Pi 中运行 `/reload`，再输入 `/plan-demo`。命令直接打开固定中文示例，复用正式计划的审阅界面，可测试点击输入框、全文评论、行评论与中文输入。

演示中的批准、发送、只写文档和打回只结束演示；不会调用模型、写计划文件或改变当前权限模式。评论仅用于本次测试，关闭窗口后丢弃。

## 独立维护

这个目录是 pi-plan-mode 的自有 extension 副本，作为独立项目边界维护。运行时通过本地 package 加载它，避免 `@bachi/pi-coder` 更新时覆盖 plan-mode 的审阅界面定制。

后续维护流程：先在这个目录完成改动并运行测试，再按需初始化独立 Git 仓库、绑定 GitHub 远端并同步。上游 re-vendor 时只复制需要的基础文件，然后重新应用本项目的审阅层改动；不要直接覆盖整个目录。


```sh
PI_TEST_PI_ENTRY=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js \
  node --test extensions/plan-mode/
```

The `node_modules` symlink points at the active pi release
(`~/.pi/agent/install/releases/<version>/node_modules`) so `@earendil-works/*`
and `typebox` resolve. Re-point it after a pi version bump if tests fail to
resolve peers.
