# pi-simple-task

Vendored copy of `@bachi/pi-coder` 的 `extensions/simple-task`（base：pi-coder **2.5.6**），
叠加个人改动（2026-11-10 起）：

1. **双列自适应排版**：终端宽度放得下（`2×最宽行 + 2 ≤ 宽`）且可见任务 ≥ 4 条时，
   任务行按「从左到右、从上到下」排成两列；每格左对齐（右补空格），奇数条末行右格留空。
   窄终端 / 短清单自动回退单列，与上游行为逐字节一致。
2. **折叠提示并入头部**：`… N more` / `… and N more` 两行独立提示删除，
   改为头部行尾追加 dim 色 `↑N ↓N`（只显示非零侧）。
3. **Nerd Font 图标**：`GLYPHS`（widget.ts 顶部）换成 NF 码点；想回退改这一个表即可。

## 接线

`~/.pi/agent/settings.json`：
- `npm:@bachi/pi-coder` 条目排除 `"!extensions/simple-task/**"`（防双份注册 task_* 工具）
- packages 数组挂 `"../../Dev/pi-agent/simple-task"`

`node_modules` symlink 指向当前 pi release，供测试解析 peer deps
（pi 升级后记得重指，照抄 plan-mode 的做法）。

## 上游同步（re-vendor）

pi-coder 更新后若上游 simple-task 有变化：把新版的 5 个源文件 + 4 个测试文件复制进
`extensions/simple-task/`，再保留本 README 列的三处个人改动（改动全部集中在
`widget.ts` 的 `buildWidgetLines` + `GLYPHS`，其余文件应与上游零差异）。
