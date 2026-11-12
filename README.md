# pi-extensions

Self-made [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
extensions, maintained as one monorepo. Runtime wiring is symlinks from
`~/.pi/agent/extensions/` into this repo — edit here, commit, `/reload`.

## Layout

| Extension | What it does |
|---|---|
| `extensions/codeapi-images.ts` | `/image` generation via CodeAPI（密钥经 `!cat ~/.pi/agent/secrets/codeapi-key` 读入，不入库） |
| `extensions/effort.ts` | `/effort` → `/thinking` 别名 |
| `extensions/ghostty-status/` | Ghostty 标签页标题 + 进度标记（OSC 0/9;3/9;4/7501） |
| `extensions/ui-polish/` | 聚合入口：mode-status-highlight（模式加粗）、stable-footer-height（两行底栏）、task-progress-nudge（长任务进度提示） |
| `extensions/plan-mode/` | vendored `@bachi/pi-coder` plan-mode（2.5.6）+ 个人审阅界面定制，详见其 README |
| `extensions/simple-task/` | vendored `@bachi/pi-coder` simple-task（2.5.6）+ 双列布局 + NF 图标，详见其 README |
| `extensions/transcript-viz/` | 会话转录可视化（**WIP**，开发中） |

## Wiring（新机器恢复）

1. `~/.pi/agent/extensions/` 下建 symlink 指向本 repo 对应条目：
   `codeapi-images.ts`、`effort.ts`、`ghostty-status`、`ui-polish`、`plan-mode`、`simple-task`、`transcript-viz`
2. `~/.pi/agent/settings.json` 的 `npm:@bachi/pi-coder` 条目排除
   `"!extensions/plan-mode/**"`、`"!extensions/simple-task/**"`（防双份注册）
3. repo 根：`ln -s ~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules node_modules`（测试解析 peer deps 用，pi 升级后重指）

## Tests

```sh
cd ~/Dev/pi-agent
PI_TEST_PI_ENTRY=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js \
  node --test extensions/
```

## 上游同步策略

`plan-mode` 与 `simple-task` 是 vendored fork：与上游**可选同步**，不强制。
re-vendor 步骤见各自 README（复制基础文件 → 重放个人改动 → 测试）。

## 不入库的内容

`node_modules`、`.pi/`、`.DS_Store`（见 `.gitignore`）；`pi-safety-guards` 的
`config.json` 等本机配置；密钥文件。
