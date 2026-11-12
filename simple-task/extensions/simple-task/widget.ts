/**
 * widget.ts — 清单渲染，样式参照 @tintinweb/pi-tasks。
 *
 * 照搬的样式要素（pi-tasks `src/ui/task-widget.ts`）：
 *   - 头部一行：`<icon> N tasks (X done, Y in progress, Z open)`，accent 色
 *   - 任务行两空格缩进，格式 `  <符号> <dim 的 #id> <正文>`
 *   - 已完成：success 色符号 + dim 且带删除线的正文
 *   - 进行中：accent 色符号 + accent 色正文 + 省略号（表示仍在跑）
 *   - 待办：无色符号 + 普通正文
 *   - 视口大小 8（超过就开始折叠）；窗口跟随进度滚动：见 viewport.ts
 *   - 整行按终端宽度截断，截断标记用 "..."（三个 ASCII 点，pi-tui 的默认）
 *
 * 2026-11-10 用户定的三处改动（vendored 包与上游 pi-coder 2.5.6 的差异全在本文件）：
 *   1. **双列自适应**：可见任务 ≥ TWO_COLUMN_MIN_TASKS 条且 `2×最宽格 + COLUMN_GUTTER
 *      ≤ 终端宽` 时，任务行按「从左到右、从上到下」排成两列 —— 每格左对齐（右补空格
 *      到最宽格宽），第二列起点固定在 colWidth + GUTTER。奇数条时末行只有左格。
 *      放不下或任务太少就退回单列，路径与上游逐字节一致。量宽用 pi-tui 的
 *      visibleWidth（剥 ANSI、中文按 2 列、NF 私有区按 1 列），与截断同源不会错位。
 *   2. **折叠提示并入头部**：上游的独立行 `… N more` / `… and N more` 取消，改为
 *      头部行尾追加 dim 色 `↑N ↓N`（只显示非零侧；↑=上面折叠的条数，↓=下面）。
 *      双列模式下独立提示行还会打断列网格，并入后顶行永远是头部行。
 *   3. **Nerd Font 图标**：GLYPHS 换成 NF 码点（Font Awesome 区，终端需装 NF 字体，
 *      ghostty 默认带）；想回退 Unicode 符号只改 GLYPHS 这一张表。
 *
 * 颜色**全部走 theme.fg()**，一处硬编码颜色都没有 —— 换主题就换配色，不需要改这里。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countByStatus, type State, type Task } from "./types.ts";
import { computeViewport, MAX_VISIBLE as MAX_VISIBLE_TASKS } from "./viewport.ts";

export const GLYPHS = {
	header: "\u{F0AE}", //  nf-fa-tasks
	pending: "\u{F10C}", //  nf-fa-circle_o（空心圆 = 还没开始）
	inProgress: "\u{F192}", //  nf-fa-dot_circle_o（圆心加点 = 进行中）
	done: "\u{F058}", //  nf-fa-check_circle（对勾圆 = 完成）
	overflow: "…",
	truncation: "...",
} as const;

/** 进行中符号（2026-10-02 起静态单帧；留数组便于日后恢复动画帧序列）。 */
export const SPINNER = [GLYPHS.inProgress, GLYPHS.inProgress] as const;

/** 视口大小（现为 8，见 viewport.ts）。超出部分折叠，计数并入头部行尾的 ↑/↓ 提示。 */
export const MAX_VISIBLE = MAX_VISIBLE_TASKS;

/** 折列门槛与列间距（2026-11-10 用户定：可见任务 4 条起折列，格间空 2 列）。 */
export const TWO_COLUMN_MIN_TASKS = 4;
export const COLUMN_GUTTER = 2;

export function buildWidgetLines(state: State, frame: number, theme: Theme, width: number): string[] {
	const tasks = state.tasks;
	if (tasks.length === 0) return [];

	const safeWidth = Math.max(1, width);
	const truncate = (line: string): string => truncateToWidth(line, safeWidth, GLYPHS.truncation);

	const { done, inProgress, pending } = countByStatus(state);
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (pending > 0) parts.push(`${pending} open`);
	const noun = tasks.length === 1 ? "task" : "tasks";
	const statusText = `${tasks.length} ${noun} (${parts.join(", ")})`;

	const { start, end, head, tail } = computeViewport(tasks, MAX_VISIBLE);

	// 头部永远画：总量 + 折叠提示都在这一行（2026-11-10 起提示并入，见文件头注释 2）。
	const hints: string[] = [];
	if (head > 0) hints.push(`↑${head}`);
	if (tail > 0) hints.push(`↓${tail}`);
	const hintSuffix = hints.length > 0 ? theme.fg("dim", `  ${hints.join(" ")}`) : "";
	const lines: string[] = [truncate(`${theme.fg("accent", GLYPHS.header)} ${theme.fg("accent", statusText)}${hintSuffix}`)];

	const visible = tasks.slice(start, end);
	const cells = visible.map((task) => taskCell(task, frame, theme));
	const colWidth = Math.max(...cells.map((cell) => visibleWidth(cell)));

	if (visible.length >= TWO_COLUMN_MIN_TASKS && colWidth * 2 + COLUMN_GUTTER <= safeWidth) {
		// 行主序双列：左格右补空格到最宽格，第二列起点固定 —— 两列都左对齐。
		const half = Math.ceil(visible.length / 2);
		for (let row = 0; row < half; row += 1) {
			const left = cells[row]!;
			const right = cells[row + half];
			if (right === undefined) {
				lines.push(left);
				continue;
			}
			const pad = " ".repeat(colWidth - visibleWidth(left));
			lines.push(`${left}${pad}${" ".repeat(COLUMN_GUTTER)}${right}`);
		}
	} else {
		for (const cell of cells) lines.push(truncate(cell));
	}

	return lines;
}

function taskCell(task: Task, frame: number, theme: Theme): string {
	if (task.status === "done") {
		// 完成项：success 符号 + dim 删除线正文（id 与正文一起划掉）
		return `  ${theme.fg("success", GLYPHS.done)} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.text}`))}`;
	}
	const dimId = theme.fg("dim", `#${task.id}`);
	if (task.status === "in_progress") {
		// 进行中：符号随 frame（当前静态单帧），正文 accent + 省略号表示还没结束
		return `  ${theme.fg("accent", SPINNER[frame % SPINNER.length])} ${dimId} ${theme.fg("accent", task.text + GLYPHS.overflow)}`;
	}
	return `  ${GLYPHS.pending} ${dimId} ${task.text}`;
}
