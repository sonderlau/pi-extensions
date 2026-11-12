# pi-extensions

Self-made [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
extensions, maintained as one monorepo — one extension per top-level entry.
Runtime wiring is symlinks from `~/.pi/agent/extensions/` into this repo:
edit here, commit, `/reload`.

## 扩展一览

### `image-gen.ts` — 生图模型接入

把生图模型注册成 pi 的普通 provider，agent 可以像选聊天模型一样选生图模型、被路由到生图任务。当前后端是 CodeAPI（codeapi.icu，OpenAI Images 协议，与 codeapi 聊天 provider 共用密钥）：`gpt-image-2`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`。纯文本提示词走 `/images/generations`，带输入图走 `/images/edits`（图生图）。设计上后端可插拔：以后接入其他生图服务时在此文件追加 provider/model 即可。密钥经 `!cat ~/.pi/agent/secrets/codeapi-key` 读入，不入库。

### `effort.ts` — /effort 别名

`/effort` 等价 `/thinking`：`/effort high` 直接切思考档位。内置斜杠命令优先于扩展命令，所以它把 `/thinking` 重新填进输入框并提交。

### `ghostty-status/` — Ghostty 终端状态

向 Ghostty 报告 pi 运行状态：标签页标题（OSC 0 / OSC 9;3）显示当前活动（正在跑的工具 / waiting for you），标签栏下沿进度标记（OSC 9;4），以及面向未来终端的 OSC 7501 program-status。需要保持 `terminal.showTerminalProgress` 关闭，否则其 keepalive 会盖掉「等待用户」状态。

### `ui-polish/` — 四件 UI 微调（聚合入口）

`index.ts` 聚合加载目录内四个单文件扩展：

- **mode-status-highlight**：状态栏里的权限模式段（plan / bypass / dangerous）加粗。模式名是安全信息不是装饰，灰色默认样式容易看漏。
- **stable-footer-height**：底栏锁定 2 行。Starship 随 git/状态宽度在 1–2 行间回流，就是闪烁的来源；空 footer 保持隐藏。
- **smooth-page-scroll**：PageUp/PageDown 单次翻页约 150ms 滑过去，视线能跟上重叠的那几行。连按或按住重复键则取消动画直接跳。方向键和滚轮仍是瞬间的。
- **task-progress-nudge**：中途提醒模型推进任务清单（simple-task 的补充）。清单有 in_progress 项且模型 90 秒没碰清单时，在下一个工具结果后追加一行提示，防止弱模型把 `task_update` 攒到回合末一次性补齐。
### `plan-mode/` — 计划模式 + 审阅界面（vendored fork）

`@bachi/pi-coder` plan-mode（base 2.5.6）的个人副本，叠加自研审阅界面：整份计划可滚动查看、`L123:` 行评论、双确认按钮（批准/打回/只写文档/修改后实施）。批准后计划原文存入项目 `.pi/plans/`。命令族：`/plan`、`/plan list|show|edit|implement|export`、`/plan-demo`（固定示例快速测审阅 UI）。上游 2.5.6 删除了审阅 UI 的接入缝，无法用独立扩展替换审批对话框，只能 vendor。详见 [plan-mode/README.md](plan-mode/README.md)。

### `simple-task/` — 任务清单（vendored fork）

`@bachi/pi-coder` simple-task（base 2.5.6）的个人副本：会话级任务清单，agent 自主管理（`task_set` / `task_update`），无需 plan 模式。个人改动：任务多时自动折成双列（可见 ≥4 条且宽度放得下才折，窄终端回退单列）、折叠数并入头部行尾 dim `↑N ↓N`、图标换 Nerd Font 码点。详见 [simple-task/README.md](simple-task/README.md)。

### `transcript-viz/` — 会话转录图表（已停止开发）

把会话转录渲染成终端图表（stat·kpis、progress·jobs、diverging·pnl 等图族），用于回看长会话。**2026-11-12 起停止开发**，保留存档；接线仍在，但不再维护。

## Wiring（新机器恢复）

1. `~/.pi/agent/extensions/` 下建 symlink 指向本 repo 对应条目：
   `image-gen.ts`、`effort.ts`、`ghostty-status`、`ui-polish`、`plan-mode`、`simple-task`、`transcript-viz`
2. `~/.pi/agent/settings.json` 的 `npm:@bachi/pi-coder` 条目排除
   `"!extensions/plan-mode/**"`、`"!extensions/simple-task/**"`（防双份注册；这两串指 npm 包内部路径，与本 repo 目录结构无关）
3. repo 根：`ln -s ~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules node_modules`（测试解析 peer deps 用，pi 升级后重指）

## Tests

```sh
cd ~/Dev/pi-agent
PI_TEST_PI_ENTRY=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js \
  node --test .
```
### 为什么没有 package.json

本 repo 的依赖只有一个：pi 本体（`@earendil-works/pi-coding-agent` 及其 `pi-tui`），且是 peer 性质——代码里 import 的版本必须与**正在运行的 pi** 一致，自己 `npm install` 一份反而可能与运行时漂移。所以不做依赖安装，直接把根目录 `node_modules` symlink 到当前 pi release 的 node_modules：

```sh
ln -sfn ~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules ~/Dev/pi-agent/node_modules
```

克隆后首次跑测试、以及每次 pi 升级后，重跑上面同一条命令即可（`-sfn` 原子替换旧链接）。若未来某扩展真的需要第三方 npm 依赖，再单独为它引入依赖管理也不迟。


## 上游同步策略

`plan-mode/` 与 `simple-task/` 是 vendored fork：与上游**可选同步**，不强制。
re-vendor 步骤见各自 README（复制基础文件 → 重放个人改动 → 测试）。

## 不入库的内容

`node_modules`、`.pi/`、`.DS_Store`（见 `.gitignore`）；`pi-safety-guards` 的
`config.json` 等本机配置；密钥文件。
