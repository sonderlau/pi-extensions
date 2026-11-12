/**
 * 中途提醒模型推进任务清单（simple-task 的补充，不改 pi-coder 本体）。
 *
 * 为什么需要：simple-task 只在 `before_agent_start` 注入 "Current task list …"。
 * 一个 turn 跑 30~50 分钟时它一次都不会再出现，弱模型于是把 task_update 攒到最后
 * 一次性补齐（2026-10-18 的 Nowcast 会话里 #3 #4 #5 #7 在最后一条消息里一起标 done，
 * 实际早已完成 40 分钟）。widget 渲染没问题，缺的是**同一 turn 内**的提醒。
 *
 * 做法：清单里有 in_progress 项、且模型已经 90 秒没碰清单时，在下一个普通工具结果
 * 后面追加一行提示 —— 它就落在模型下一次请求的上下文里，位置比 per-turn 提醒更近。
 * 时限流成「模型每次操作清单后至少安静 90 秒才提醒一次」。
 *
 * 状态从会话分支上的 `simple-task-state` 快照读（simple-task 用 pi.appendEntry 存的全量
 * 快照），只读、不写文件、不重复 appendEntry。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 这些工具自己就是清单操作，不需要再提醒。 */
const TASK_TOOLS = new Set(["task_set", "task_update", "task_get", "todo"]);
const STATE_ENTRY = "simple-task-state";

/** 模型两次操作清单之间的最短提醒间隔。 */
export const NUDGE_INTERVAL_MS = 90_000;

export interface TaskItem {
	id: number;
	text: string;
	status: string;
}

export interface TaskState {
	active: boolean;
	tasks: TaskItem[];
}

interface StateEntry {
	type?: string;
	customType?: string;
	data?: { state?: TaskState; enabled?: boolean };
}

/**
 * 取当前分支上最后一条 simple-task 快照。
 * 用 getBranch() 而不是全部 entry：分支回退后不该拿被丢弃分支的清单去提醒。
 * 清单被关掉（/tasks off）或没有清单时返回 undefined —— 那种情况下不该打扰模型。
 */
export function readState(entries: readonly unknown[]): TaskState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as StateEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (entry.data?.enabled === false) return undefined;
		const state = entry.data?.state;
		return state && Array.isArray(state.tasks) && state.active ? state : undefined;
	}
	return undefined;
}

/** 90 秒内既没操作过清单、也没提醒过，才值得再说一次。 */
export function shouldNudge(now: number, lastTaskAt: number, lastNudgeAt: number): boolean {
	return now - lastTaskAt >= NUDGE_INTERVAL_MS && now - lastNudgeAt >= NUDGE_INTERVAL_MS;
}

export function buildNudge(state: TaskState | undefined): string | undefined {
	if (!state?.active || state.tasks.length === 0) return undefined;
	const done = state.tasks.filter((task) => task.status === "done").length;
	const current = state.tasks.find((task) => task.status === "in_progress");
	if (current) {
		return (
			`[task list] #${current.id} "${current.text}" is still in_progress ` +
			`(${done}/${state.tasks.length} done). Call task_update the moment a task actually finishes ` +
			"— one task per call, never batch several at the end of the run. Ignore this if that task is still running."
		);
	}
	// 没有 in_progress（模型只 task_set 就干活，或把 done 全标完只剩 pending）时
	// 也必须提醒，否则这条尾巴会一直拖到 turn 结束 —— 2026-10-19 的 NiB 会话就是这样。
	const next = state.tasks.find((task) => task.status === "pending");
	if (!next) return undefined;
	return (
		`[task list] nothing is in_progress (${done}/${state.tasks.length} done). ` +
		`If you are working on #${next.id} "${next.text}", call task_update to mark it in_progress now, ` +
		"and mark each task done the moment it finishes — one task per call, never batch at the end of the run."
	);
}

export default function taskProgressNudge(pi: ExtensionAPI): void {
	let lastTaskAt = Date.now();
	let lastNudgeAt = 0;

	pi.on("session_start", () => {
		lastTaskAt = Date.now();
		lastNudgeAt = 0;
	});

	pi.on("tool_call", (event) => {
		if (TASK_TOOLS.has(event.toolName)) lastTaskAt = Date.now();
	});

	// 嵌套调用（codemode 脚本里调的）不单独提醒：它的结果不会作为独立工具结果进上下文，
	// 宿主工具自己那条结果会走这里。
	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		if (event.parentToolCallId || TASK_TOOLS.has(event.toolName)) return;
		const now = Date.now();
		if (!shouldNudge(now, lastTaskAt, lastNudgeAt)) return;

		const hint = buildNudge(readState(ctx.sessionManager.getBranch()));
		if (!hint) return;
		lastNudgeAt = now;

		return {
			content: [...event.content, { type: "text" as const, text: hint }],
			// 只替换 content 会丢掉结构化结果，原样带回去
			structuredContent: event.structuredContent,
		};
	});
}
