/**
 * Three permission modes with plan review and a project-local Markdown library.
 * Approval saves the reviewed snapshot directly, then restores the entry mode.
 * Saved plans must be reviewed again before implementation.
 * Planning tool restrictions are guardrails for a cooperative model, not a sandbox.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type PlanDocMode,
	type PlanState,
	type ReturnPhase,
	cancelPlan,
	enterPlan,
	exitDangerous,
	exitPlanTo,
	initialPlanState,
	inspectBashCommand,
	nextCyclePhase,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	submitPlan,
} from "./plan.ts";
import { setSandboxMode } from "./sandbox-mode.ts";
import {
	buildPlanModeContext,
	buildRejectedMessage,
	buildRevisionMessage,
	formatApprovalNotes,
	truncatePlanForDialog,
} from "./plan-text.ts";
import { exportPlan, hashText, listPlans, readPlan, saveEditedPlan, savePlanSnapshot } from "./plan-library.ts";
import { installLiveImeWindow } from "./ime-window.ts";
import { showPlanReview, type PlanReviewResult } from "./review-ui.ts";
import type { FrameDeps } from "./frame.ts";
import { brainstormingLoadedInRun, messagesFromBranch } from "./brainstorm.ts";
import { buildApprovalTitle, buildConsentTitle } from "./consent.ts";
import {
	STATUS_KEY,
	TREE_PIPE,
	classifyPlanToolOutcome,
	formatPlanStatus,
	planResultTreePrefixes,
	planToolTitleParts,
	type PlanToolOutcome,
} from "./render.ts";
import { THINKING_FALLBACK_KEY, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";

/**
 * 弹框正文线框的几何来源（见 `frame.ts`）：框宽取**对话框内容宽**，折行与量宽直接用
 * pi-tui 的实现 —— 与弹框自己的组件同口径，框里的折行才不会与预算算出来的行数打架。
 *
 * 为什么是 `columns - 2` 而不是终端列数：`ExtensionSelectorComponent` 把 title 塞进
 * `new Text(title, 1, 0)`，那个 `paddingX = 1` 让正文可用宽度是「列数 - 2」。按整宽画框
 * 会每行溢出 2 列、被组件再折一次，右边框全掉到下一行（实测）。与 `plan-text.ts` 的
 * `dialogPlanBudget` 同一个口径：那里的 `contentWidth` 也是减掉这 2 列再减 `FRAME_INSET`。
 */
function dialogFrame(): FrameDeps {
	const columns = process.stdout.columns || Number(process.env.COLUMNS) || 80;
	return {
		columns: Math.max(1, columns - 2),
		wrap: wrapTextWithAnsi,
		measure: visibleWidth,
	};
}

/** 关掉整个扩展。 */
const DISABLED = (process.env.PI_PLAN_MODE ?? "").trim().toLowerCase() === "off";
/** 只关自动进入（shift+tab 与 /plan 仍可用）。 */
const AUTO_DISABLED = (process.env.PI_PLAN_MODE_AUTO ?? "").trim().toLowerCase() === "off";
/** 关掉模型自动进入前的同意弹框（回到「调了就直接进」）。 */
const CONSENT_DISABLED = (process.env.PI_PLAN_MODE_CONSENT ?? "").trim().toLowerCase() === "off";

const DEMO_PLAN = `# 中文输入体验测试

## 背景

当前 plan 审阅界面需要按英文 c 才能开始评论。当用户使用中文输入法时，需要反复切换中英文输入法，操作很麻烦。

## 方案

- 让评论输入框始终显示。
- 浏览计划时不自动聚焦输入框。
- 点击输入框后进入编辑态。
- 未选中计划行时，评论针对整篇文档。
- 选中某一行后，评论针对该行。
- 评论内容需要支持中文输入。

## 验证

- 直接点击底部输入框。
- 输入一段中文。
- 按 Enter 保存评论。
- 点击计划正文，确认不会自动进入输入态。
- 选中某行后再次输入评论。`;

const ENTER_TOOL = "enter_plan_mode";
const EXIT_TOOL = "exit_plan_mode";
/** 会话里持久化状态的 custom entry 类型。 */
const ENTRY_TYPE = "plan-mode";

/** 审批对话框的三个选项（顺序即默认选中顺序：第一项是推荐路线）。 */
const CHOICE_EXECUTE = "Write the plan and implement";
const CHOICE_DOC_ONLY = "Write the plan only";
const CHOICE_REJECT = "Reject";

type ApprovalContext = {
	hasUI: boolean;
	mode?: string;
	ui: {
		theme: Theme;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		custom?: Parameters<typeof showPlanReview>[0]["custom"];
	};
};

/** TUI 用渲染审阅（滚动/行号意见/双击确认）；其它宿主退回三选一 select。无 UI 时直接实施，避免 headless 死锁。 */
async function resolvePlanApproval(
	ctx: ApprovalContext,
	plan: string,
): Promise<PlanReviewResult> {
	if (!ctx.hasUI) return { kind: "execute", notes: [] };
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		try {
			const reviewed = await showPlanReview(ctx.ui, plan);
			if (reviewed) return reviewed;
		} catch {
			// 渲染失败不要卡死审批，退回原来的 select。
		}
	}
	// confirm/select 对话框是一个不可滚动的 Text，主屏渲染又把视口钉在底部 ——
	// 长计划必然看不全。截到一屏放得下；被截掉的部分仍写进了终端缓冲区，用户
	// 上翻可看全文（弹窗期间重绘已冻结）。
	const dialogPlan = truncatePlanForDialog(
		plan,
		{
			rows: process.stdout.rows || Number(process.env.LINES) || 24,
			columns: process.stdout.columns || 80,
		},
		wrapTextWithAnsi,
	);
	const choice = await ctx.ui.select(buildApprovalTitle(ctx.ui.theme, dialogPlan, dialogFrame()), [
		CHOICE_EXECUTE,
		CHOICE_DOC_ONLY,
		CHOICE_REJECT,
	]);
	if (choice === undefined || choice === CHOICE_REJECT) return { kind: "reject" };
	if (choice === CHOICE_DOC_ONLY) return { kind: "doc-only", notes: [] };
	return { kind: "execute", notes: [] };
}

/**
 * 同意弹框的两个选项（第一项是默认选中项 = 接受模型的请求）。
 *
 * 这是 Claude Code 的机制：它的 `EnterPlanMode` 是 `shouldDefer: true`，描述里明写
 * “This tool REQUIRES user approval - they must consent to entering plan mode”，弹框是
 * `Yes, enter plan mode` / `No, start implementing now`。正因为每次进入都要用户点头，
 * CC 才敢把判据写松（还留了 “err on the side of planning”）—— 误判的代价被弹框吸收了。
 * 没有这道弹框时，判据一松就直接变成打扰（实测 15.5% 的用户指令进了 plan）。
 */
const CONSENT_PLAN = "Enter plan mode (read-only)";
const CONSENT_IMPL = "Implement directly";

/**
 * `enter_plan_mode` 的工具描述 = 全部路由判据。
 *
 * 判据只写在这里，全局 AGENTS.md 只留一条指针（Claude Code 同构：它的系统提示词里
 * 一句 plan 规则都没有，7 条正面条件 + 4 条豁免 + GOOD/BAD 示例全在工具描述里）。
 * 这样判据在模型决定要不要调这个工具的那一刻正好在眼前，而且不会与 AGENTS.md 漂移。
 * 结构照 CC：什么时候用（7 条）/ 什么时候不用（4 条豁免）/ 例子 / 注意。
 */
const ENTER_TOOL_DESCRIPTION = `进入 plan mode（只读探索）：先把方案讲清楚、等用户批准，再动手实施。

## 什么时候用
非简单的实施类任务，命中任意一条就该用：
1. 新功能：要加一块有意义的新能力（放哪、点了之后发生什么、错误怎么处理都还没定）
2. 多种可行方案：同一目标有几条明显不同的路（缓存用 Redis / 内存 / 文件；实时用 WS / SSE / 轮询）
3. 改动既有行为或结构：更新登录流程、重构某个组件——目标形态未定
4. 架构取舍：要在模式或技术之间选一个
5. 多文件：预计要动 2-3 个以上文件
6. 需求不清：得先探索才知道范围（「让它更快」要先 profile；「修 checkout 的 bug」要先定位根因）
7. 用户偏好决定走向：实现可以合理地分成几种——如果你正打算用 ask_user_question 问方案，就改用这个工具（先探索，再带着上下文给选项）

## 什么时候不用
只有这几类跳过：
- 一两行的小修（错别字、明显的 bug、小调整）
- 需求明确的单个函数
- 用户已经给了具体、详细的指令（照做即可，方案没有分叉）
- 纯调研 / 探索 / 审阅（「哪些文件负责路由」、「对比 A 和 B 写份报告」、「审一下这个文档」——产出是结论，不是改动）
- **本次 run 已经加载了 brainstorming 技能**（read 过它的 SKILL.md）——两者二选一：brainstorming 自带「澄清 → 2-3 方案 → 批准 → 设计文档 → writing-plans 实施计划」全流程，与本工具重叠，按它走就行（扩展也会拦下这次调用）

## 例子
该用：「给应用加用户认证」（session vs JWT、token 存哪、中间件结构都要定）／「优化数据库查询」（多种路子、要先 profile）／「实现暗色主题」（主题系统的架构决定，波及很多组件）／「给用户资料页加个删除按钮」（看着简单，其实要定位置、确认框、API 调用、错误处理、状态更新）
不该用：「修 README 里的错别字」／「给这个函数加个 console.log 调试」／「哪些文件负责路由」

## 注意
- 这个工具需要用户同意：调用后会弹框，用户可以选「直接实施」否掉它。所以拿不准就调——误判的代价是用户按一次键，不是白做一轮。
- 用户自己按 shift+tab / /plan / --plan 进入时不弹框（那已经是用户的决定）。
- **brainstorming 与本工具二选一，同一任务只用一套设计流程。** 本次 run 已加载 brainstorming → 全程按它走，不要调用本工具；未加载而任务命中上面的判据 → 照常调用。若已经在 plan 态里才想起 brainstorming，可以 read 它的方法论（逐条澄清、给 2-3 个方案带取舍），但它的文件布局在 plan mode 里不适用：不写 docs/superpowers/specs/、不 commit（一切写操作都被拦），设计产物由 exit_plan_mode 提交后统一落 .pi/plans/；技能里的「逐条提问」在这里就是 ask_user_question 工具。`;

interface PersistedState {
	phase: PlanState["phase"];
	returnPhase?: ReturnPhase;
	pending?: string;
	toolsBeforePlan?: string[];
	docMode?: PlanDocMode;
	docWriting?: boolean;
	pendingDocPath?: string;
	planSummary?: string;
}

/**
 * 把落盘条目里的 phase 收敛到当前联合类型，认不出的一律当 `"bypass"`。
 *
 * 白名单式判定兜住一切历史值：2026-09-23 的 `normal` → `bypass` 改名、2026-09-24 删掉
 * 的 `execute` 态、以及 2026-09-27 三态化之前的旧会话（它们只写过 bypass / plan）。
 * **认不出的值绝不落到 dangerous** —— 那是唯一会关掉沙箱的态，必须由用户亲手切到。
 */
function normalizePhase(value: unknown): PlanState["phase"] {
	return value === "plan" || value === "dangerous" ? value : "bypass";
}

/** 落盘条目里的 returnPhase 同样白名单式收敛：认不出的当没记过（收尾时退回 bypass）。 */
function normalizeReturnPhase(value: unknown): ReturnPhase | undefined {
	return value === "dangerous" ? "dangerous" : value === "bypass" ? "bypass" : undefined;
}


/** 落盘条目里的 pending：2026-09-24 之前是步骤数组，现在只认字符串（旧计划丢弃）。 */
function normalizePending(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// =============================================================================
// 工具调用块的渲染（enter_plan_mode / exit_plan_mode 共用）
// =============================================================================

/**
 * 正文树的前导缩进与树形 gutter 的几何（用户 2026-09-29 第三轮定）：
 *
 * ```
 * • enter_plan_mode ✔
 *   │ 正文……
 * ```
 *
 * 标题行从状态圆点起**顶格**（圆点是这一块的状态灯，贴着左边界块与块才分得开）；
 * 正文树前面挂 **2 列**缩进（`BODY_INDENT`），让 `│` / `└` 正好落在 `enter_plan_mode`
 * 的第三个字母 `e` 正下方（列 2），正文从列 4 起。早期版本只挂 1 列（`│` 在列 1），
 * 用户看实际效果后要求再加一格 —— 树与标题错开两列，层次比错一列更清楚。
 */
const BODY_INDENT = "  ";
const GUTTER_WIDTH = 2;

/**
 * 行级渲染状态（pi 的 `rendererState`，每个工具行一份、renderCall 与 renderResult 共享）。
 *
 * 它存在的唯一理由：标题行的结局标记（✔ / ✘）取决于 `result.details`，而
 *   ① `getRenderContext()` **不暴露 result 本体**（只有 isPartial / isError / state 等），
 *   ② 同一次 `updateDisplay()` 里 callRenderer **先于** resultRenderer 执行。
 * 所以 renderResult 把分类写进 state，renderCall 返回一个**在 `render(width)` 时才读
 * state 的懒组件** —— 屏幕真正绘制发生在 updateDisplay() 之后，那时已经写好了。
 * 懒组件（只需 `render` / `invalidate`）是 bash-command-collapse 的既有做法。
 */
interface PlanToolRenderState {
	outcome?: PlanToolOutcome;
}

/** renderCall / renderResult 拿到的 context 里、本扩展真正会读的那几个字段。 */
interface PlanToolRenderContext {
	state: PlanToolRenderState;
	isPartial: boolean;
	isError: boolean;
}

/** 结果块里的文本正文（其余块类型这两个工具不会产生）。 */
interface PlanToolResultLike {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	details?: unknown;
}

/** 把结果里的所有 text 块拼成全文（按块顺序，块之间换行）。 */
function planResultText(result: PlanToolResultLike): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/**
 * 两个工具共用的渲染器：`renderShell: "self"` + 树形标题/正文。
 *
 * ## 为什么必须 self 壳
 *
 * 默认壳是 `contentBox = new Box(1, 1, bgFn)`（tool-execution.js）：整块套
 * `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` 底色，`paddingY = 1` 给上下各一行
 * 空行，构造时那个 `Spacer(1)` 再给上方一行。self 模式下 `render()` 绕过
 * `super.render()`（Spacer 不画）、容器是纯 `Container`（`instanceof Box` 为 false，
 * bgFn 套不上去），于是**没有底色、下方没有空行**；上方只剩 pi 在 self 分支里写死的
 * 那一行 `lines.push("")` —— 去不掉，bash / simple-task / tool-diff 块同样如此。
 *
 * ## 形态（用户 2026-09-29 定）
 *
 * ```
 * • enter_plan_mode ✔
 *   │ 已进入 plan mode（只读）。原因：跨 gateway/config.yaml 与 pi、
 *   └ opencode、codex 三端配置的行为改动。
 * ```
 *
 * 标题行 = 状态圆点 + 加粗工具原名 + 结局标记（四态配色见 `planToolTitleParts`），
 * **从圆点起顶格**；正文是**结果全文**（用户选的：给模型的指令也一并显示），前面挂
 * `BODY_INDENT` 那 2 列再折行挂树（于是 `│` 落在工具名首字母正下方）——
 * 除末行外 `│ `，**末行 `└ `**（与 bash 块「`└` 只落在第一个实质输出行」刻意分叉，
 * 见 render.ts 文件头）。结构符走 `dim` 槽且**自成一段 SGR**，不让正文色透上来。
 *
 * 正文走 `text` 槽（用户 2026-09-29 定）而不是 `toolOutput`：计划正文是要用户逐字读、
 * 并据此拍板的内容，不该跟 read / grep 的输出正文一样被压暗。`text` 在本机三套皮肤里
 * 都指向 `fg`（pi-coder-1337 / ayu 是 `"text": "fg"`，catppuccin 直接给 `#CDD6F4`），
 * 所以「用 fg 颜色」= 用 `text` 槽，不写死色值 —— 换皮肤时正文跟着皮肤的主前景色走。
 */
function planToolRenderers(toolName: string) {
	return {
		renderShell: "self" as const,
		renderCall(_args: unknown, theme: Theme, context: PlanToolRenderContext) {
			// state 是跨帧同一个对象，所以 render(width) 时读到的是 renderResult 刚写的分类；
			// 兜底（state 里还没有 outcome）只发生在「结果没到过」的行：执行中按 isPartial
			// 判 pending，其余按 isError 判 error / declined。
			const state = context.state;
			return {
				render(width: number): string[] {
					const outcome: PlanToolOutcome =
						state?.outcome ?? (context.isPartial ? "pending" : context.isError ? "error" : "declined");
					const parts = planToolTitleParts(outcome);
					let title = `${theme.fg(parts.dotSlot, "\u2022")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
					if (parts.mark !== "" && parts.markSlot !== undefined) {
						title += ` ${theme.fg(parts.markSlot, parts.mark)}`;
					}
					// 标题行顶格（不挂 BODY_INDENT），所以折行预算就是整个宽度
					return wrapTextWithAnsi(title, Math.max(1, width || 80));
				},
				invalidate() {},
			};
		},
		renderResult(result: PlanToolResultLike, _options: unknown, theme: Theme, context: PlanToolRenderContext) {
			// isError 必须从 **context** 读：pi 传给 resultRenderer 的对象是
			// `{ content, details }`，**没有 isError 字段**（它只在 getRenderContext() 里）。
			if (context.state) {
				context.state.outcome = classifyPlanToolOutcome(context.isError === true, result?.details);
			}
			const sourceLines = planResultText(result ?? {}).split("\n");
			// 结果是静态的，按 width 缓存排版（同 tool-diff 的 DiffCard）
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const hit = cache.get(width);
					if (hit !== undefined) return hit;
					const bodyWidth = Math.max(1, (width || 80) - BODY_INDENT.length - GUTTER_WIDTH);
					const rows: string[] = [];
					for (const line of sourceLines) {
						// 空行也占一行（wrapTextWithAnsi("") → [""]）：段落间距是可读性的一部分
						rows.push(...wrapTextWithAnsi(line, bodyWidth));
					}
					if (rows.every((row) => row.trim() === "")) {
						cache.set(width, []);
						return [];
					}
					// 前缀按**折行之后**的视觉行数算：折行碎片也算独立行，否则一个折成三行的
					// 长句会在第一片就画上 `└`，看着像树提前结束了。
					const prefixes = planResultTreePrefixes(rows.length);
					const lines = rows.map(
						(row, index) => BODY_INDENT + theme.fg("dim", prefixes[index] ?? TREE_PIPE) + theme.fg("text", row),
					);
					cache.set(width, lines);
					return lines;
				},
				invalidate() {
					cache.clear();
				},
			};
		},
	};
}

export default function planMode(pi: ExtensionAPI) {
	if (DISABLED) return;
	installLiveImeWindow();

	const state: PlanState = initialPlanState();
	/** 最近一次 ctx：onTerminalInput 回调拿不到 ctx，而 shift+tab 需要它。 */
	let currentCtx: ExtensionContext | undefined;
	/** 会话替换（/clear、/new、/resume）期间旧 ctx 会失效；渲染失败一律吞掉。 */
	let restoreInProgress = false;
	/** pi 自己的弹窗打开时不要抢键，交给弹窗。 */
	let dialogOpen = false;
	/** Unsaved editor text stays recoverable until saved or the extension reloads. */
	const editDrafts = new Map<string, { text: string; version: string }>();
	let libraryBusy = false;
	let sessionEpoch = 0;
	let thinkingKeyChecked = false;
	/** shift+tab 的原始输入监听器退订函数（防重入用，见 attachInputListener）。 */
	let inputUnsubscribe: (() => void) | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only)",
		type: "boolean",
		default: false,
	});

	// =========================================================================
	// 渲染
	// =========================================================================

	function render(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatPlanStatus(ctx.ui.theme, state));
		} catch {
			// 会话替换窗口里 ctx 可能已被 pi 作废。渲染是尽力而为，绝不能让它打死进程
			// （本机 user-message-bar 扩展踩过同一个坑，代价是 pi 直接退出）。
		}
	}

	// =========================================================================
	// 持久化（只在会话条目里）
	// =========================================================================

	function persist(): void {
		const payload: PersistedState = {
			phase: state.phase,
			returnPhase: state.returnPhase,
			pending: state.pending,
			toolsBeforePlan: state.toolsBeforePlan,
			docMode: state.docMode,
			docWriting: state.docWriting,
			pendingDocPath: state.pendingDocPath,
			planSummary: state.planSummary,
		};
		pi.appendEntry(ENTRY_TYPE, payload);
	}

	/**
	 * 只认当前分支上的最新记录。
	 *
	 * 用 getBranch() 而不是 getEntries()：后者返回**全量**条目（`session-manager.js` 的
	 * `fileEntries.filter(...)`），包含 rewind / fork / 分支导航之后被丢弃的分支 —— 用它
	 * 会让一条已经不上分支的计划在下次启动时复活。pi 的 docs/extensions.md 也要求用
	 * getBranch() 重建分支敏感状态。
	 */
	function restore(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			state.phase = normalizePhase(entry.data.phase);
			state.returnPhase = normalizeReturnPhase(entry.data.returnPhase);
			state.pending = normalizePending(entry.data.pending);
			state.toolsBeforePlan = entry.data.toolsBeforePlan;
			// Legacy model-written approvals cannot prove the saved file matches the reviewed text.
			// Keep the session read-only and require a fresh approval instead of trusting that file.
			state.docWriting = undefined;
			state.docMode = undefined;
			state.pendingDocPath = undefined;
			state.planSummary = typeof entry.data.planSummary === "string" ? entry.data.planSummary : undefined;
			break;
		}
		// plan 态恢复后工具表要跟着收回去（工具集本身不进会话条目，按当前表重算）。
		if (state.phase === "plan") {
			if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(planToolSet(state.toolsBeforePlan));
		}
	}

	// =========================================================================
	// 状态迁移
	// =========================================================================

	/**
	 * plan 阶段的活动工具：pi 的写工具 + 已经没用的 enter_plan_mode 都摘掉。
	 */
	function planToolSet(active: readonly string[]): string[] {
		return planModeToolSet(active).filter((name) => name !== ENTER_TOOL);
	}

	/**
	 * 进 plan 模式。已在 plan 里则原样返回（不覆盖工具快照与来路）。
	 * `reason` 只影响提示文案。
	 */
	function enterPlanMode(ctx: ExtensionContext | undefined, reason: "user" | "model"): void {
		if (state.phase === "plan") return;
		// 快照必须取在摘工具**之前** —— 退出时靠它原样还原（含二十多个扩展工具）
		const before = pi.getActiveTools();
		Object.assign(state, enterPlan(state, before));
		pi.setActiveTools(planToolSet(before));
		setSandboxMode(state.phase);
		persist();
		render(ctx);
		if (ctx?.hasUI) {
			ctx.ui.notify(
				reason === "model"
					? "The model judged this task needs planning first; entered plan mode (read-only). shift+tab exits at any time."
					: "Entered plan mode: read-only, the model proposes a plan first. shift+tab toggles.",
				"info",
			);
		}
	}

	/**
	 * 离开 plan 到指定的非-plan 态，还原工具表。三条出口共用：
	 * shift+tab（cancelPlan → dangerous）、`/plan`（exitPlanTo → bypass）、
	 * 扩展保存审批快照后（exitPlanTo → returnPhase）。
	 * `notifyMessage` 为空则不提示。
	 */
	function leavePlan(
		ctx: ExtensionContext | undefined,
		next: PlanState,
		notifyMessage?: string,
		severity: "info" | "warning" = "info",
	): void {
		const tools = restoredToolSet(state, pi.getActiveTools());
		Object.assign(state, next);
		pi.setActiveTools(tools);
		setSandboxMode(state.phase);
		persist();
		render(ctx);
		if (notifyMessage && ctx?.hasUI) ctx.ui.notify(notifyMessage, severity);
	}

	/**
	 * shift+tab：固定循环 dangerous → bypass → plan → dangerous。
	 * 这是**唯一**能到达 dangerous 的路径（没有命令、没有模型路径能进去）。
	 */
	function cycleNext(ctx: ExtensionContext | undefined): void {
		// 下一态统一由 `nextCyclePhase`（CYCLE_ORDER 那张表）算出来，这里只负责把
		// 三种迁移各自的副作用做对 —— 改循环顺序只需改表，不用改这里。
		const next = nextCyclePhase(state.phase);
		if (next === "plan") {
			// bypass → plan：收工具、注入只读上下文
			enterPlanMode(ctx, "user");
			return;
		}
		if (next === "dangerous") {
			// plan → dangerous：固定循环的下一态，不看 returnPhase（见 cancelPlan 的注释）。
			// 提示用 warning 级：这是唯一会关掉沙箱删除拦截的态，得说大声一点。
			leavePlan(
				ctx,
				cancelPlan(state),
				"☢ dangerous mode: sandbox delete interception is off, any permission (pi's native behaviour). Press shift+tab back to ⏵ bypass.",
				"warning",
			);
			return;
		}
		// dangerous → bypass：重新打开沙箱删除拦截（这一态没有任何扩展持有的状态）
		Object.assign(state, exitDangerous(state));
		setSandboxMode(state.phase);
		persist();
		render(ctx);
		if (ctx?.hasUI) {
			ctx.ui.notify("Left dangerous mode; now ⏵ bypass: sandbox delete interception is on. Press shift+tab to enter plan mode.", "info");
		}
	}

	/**
	 * `/plan`：只切 plan，**永远不落到 dangerous**（dangerous 只能由 shift+tab 切到）。
	 * 离开 plan 时去 **bypass**（安全默认）—— 不走固定循环的 dangerous，也不看
	 * returnPhase：一条命令不该把用户悄悄送进沙箱关闭的态。
	 */
	function togglePlanCommand(ctx: ExtensionContext | undefined): void {
		if (state.phase === "plan") {
			leavePlan(ctx, exitPlanTo(state, "bypass"), "Left plan mode (/plan); now ⏵ bypass: sandbox delete interception is on.");
			return;
		}
		enterPlanMode(ctx, "user");
	}

	// =========================================================================
	// shift+tab 抢键
	// =========================================================================

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		sessionEpoch++;
		dialogOpen = false;
		restoreInProgress = true;
		try {
			restore(ctx);
		} finally {
			restoreInProgress = false;
		}
		attachInputListener(ctx);

		if (pi.getFlag("plan") === true && state.phase !== "plan") enterPlanMode(ctx, "user");
		// 恢复/进入都做完之后再把当前态同步给沙箱层：dangerous 关拦截，其余开。
		// 本扩展没装时单例永远是默认的 bypass，拦截照旧 —— 安全默认。
		setSandboxMode(state.phase);
		render(ctx);

		if (!thinkingKeyChecked && (event.reason === "startup" || event.reason === "reload")) {
			thinkingKeyChecked = true;
			ensureThinkingKeyRebound(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		sessionEpoch++;
		currentCtx = undefined;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
	});

	/**
	 * shift+tab 在到达编辑器**之前**被这里拦下。
	 *
	 * 只在「TUI + 空闲 + 没有扩展弹窗 + 不在会话切换窗口」时 consume：pi 的 picker
	 * （/model、/sessions 等）自己也吃 shift+tab，抢它会让人在弹窗里切不动选项。
	 * 忙碌时（流式中）不抢，让 pi 的思考等级循环照常工作 —— 这是刻意的：plan mode
	 * 只在你停下来的时候才切。
	 *
	 * 防重入很重要：`session_start` 会在 `/reload`、`/new`、`/resume` 时各跑一次，
	 * 每跑一次就多注册一个监听器的话，一次 shift+tab 会被切两次（等于没切）。
	 * pi 换会话时会 `clearExtensionTerminalInputListeners()` 清掉旧的，但 `/reload`
	 * 不保证清干净 —— 所以这里自己先退订上一次。
	 */
	function attachInputListener(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		inputUnsubscribe?.();
		inputUnsubscribe = null;
			try {
			inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				// 必须用 pi 自己的 matchesKey，**不能**手写 `data !== "\x1b[Z"`：
				// shift+tab 有三种编码 —— 裸 CSI（`\x1b[Z`）、Kitty 键盘协议的 CSI-u
				// （`\x1b[9;2u` 之类）与 xterm modifyOtherKeys。pi 启动时会主动启用
				// Kitty 协议（`terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c` 并等回复），
				// 一旦启用，真实终端发的就不再是 `\x1b[Z` —— 硬编码比对会完全失效
				// （实测踩到：pty 里能切、真实 Ghostty 里按 shift+tab 没反应）。
				if (!matchesKey(data, "shift+tab")) return undefined;
				const current = currentCtx;
				if (!current || current.mode !== "tui") return undefined;
				if (dialogOpen || libraryBusy || restoreInProgress) return undefined;
				if (!current.isIdle()) return undefined;
				cycleNext(current);
				return { consume: true };
			});
		} catch {
			// 宿主没有原始输入通道：shift+tab 不可用，/plan 仍然可用
		}
	}

	pi.on("ui_prompt_start", async () => {
		dialogOpen = true;
	});
	pi.on("ui_prompt_end", async () => {
		dialogOpen = false;
	});

	// =========================================================================
	// 命令
	// =========================================================================

	pi.registerCommand("plan", {
		description: "Toggle plan mode or manage saved plans: list, show, edit, implement, export",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			if (libraryBusy || dialogOpen) {
				ctx.ui.notify("请先完成当前计划审阅或编辑。", "info");
				return;
			}
			const [action, ...parts] = args.trim().split(/\s+/).filter(Boolean);
			if (!action) {
				togglePlanCommand(ctx);
				return;
			}
			libraryBusy = true;
			const epoch = sessionEpoch;
			const ensureCurrentSession = () => {
				if (epoch !== sessionEpoch) throw new Error("会话已切换，已取消计划操作。");
			};
			try {
				const plans = listPlans(ctx.cwd);
				const selected = parts[0] || plans.at(-1);
				if (action === "list") {
					ctx.ui.notify(plans.length ? plans.join("\n") : "No saved plans.", "info");
					return;
				}
				if (action === "show") {
					if (!selected) throw new Error("没有可显示的计划。用 /plan list 查看计划。");
					const plan = readPlan(ctx.cwd, selected);
					ctx.ui.notify(plan.text, "info");
					return;
				}
				if (action === "export") {
					const match = /^export\s+(\S+)\s+(.+)$/.exec(args.trim());
					if (!match) throw new Error("用法：/plan export <file.md> <project-relative-destination>");
					const plan = readPlan(ctx.cwd, match[1]!);
					const destination = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
					const path = exportPlan(ctx.cwd, plan.text, destination);
					ctx.ui.notify(`Exported plan: ${path}`, "info");
					return;
				}
				if (action === "edit") {
					if (!ctx.hasUI || !ctx.ui.editor) throw new Error("计划编辑需要交互式 UI。");
					if (!selected) throw new Error("没有可编辑的计划。用 /plan list 查看计划。");
					const key = resolve(ctx.cwd, ".pi/plans", selected);
					let draft = editDrafts.get(key);
					if (!draft) {
						const plan = readPlan(ctx.cwd, selected);
						draft = { text: plan.text, version: plan.version };
					}
					while (true) {
						const edited = await ctx.ui.editor(`Edit ${selected}`, draft.text);
						ensureCurrentSession();
						if (edited === undefined) return;
						draft = { ...draft, text: edited };
						editDrafts.set(key, draft);
						const saved = saveEditedPlan(ctx.cwd, selected, draft.version, draft.text);
						if (saved.kind === "saved") {
							editDrafts.delete(key);
							ctx.ui.notify(`Plan updated. Run /plan implement ${selected} to review it before implementation.`, "info");
							return;
						}
						const choice = await ctx.ui.select("Plan changed or was deleted while editing", ["Save edited text as a new plan", "Reload latest version", "Cancel"]);
						ensureCurrentSession();
						if (choice === "Save edited text as a new plan") {
							const copy = savePlanSnapshot(ctx.cwd, draft.text, selected.replace(/\.md$/i, "-edited"));
							ctx.ui.notify(`Saved edited copy: ${copy}`, "info");
							editDrafts.delete(key);
							return;
						}
						if (choice !== "Reload latest version") {
							ctx.ui.notify(`Draft retained until /reload. Run /plan edit ${selected} to recover it.`, "info");
							return;
						}
						const latest = readPlan(ctx.cwd, selected);
						draft = { text: latest.text, version: latest.version };
					}
				}
				if (action === "implement") {
					if (!ctx.hasUI) throw new Error("计划实施前需要用户确认，当前环境没有交互式 UI。");
					if (!selected) throw new Error("没有可实施的计划。用 /plan list 查看计划。");
					await ctx.waitForIdle();
					ensureCurrentSession();
					const current = readPlan(ctx.cwd, selected);
					const approval = await resolvePlanApproval(ctx, current.text);
					ensureCurrentSession();
					if (approval.kind === "reject") return;
					if (approval.kind === "revise") {
						if (state.phase !== "plan") enterPlanMode(ctx, "user");
						pi.sendUserMessage(`${buildRevisionMessage(approval.comments)}\n\n待修改的计划原文：\n\n${current.text}`);
						return;
					}
					if (approval.kind === "doc-only") return;
					let verified;
					try { verified = readPlan(ctx.cwd, selected); } catch { throw new Error("计划文件在审批期间被删除，未开始实施。"); }
					if (verified.version !== current.version) throw new Error("计划文件在审批期间发生变化，未开始实施；请重新运行 /plan implement。");
					if (state.phase === "plan") {
						const returnPhase = state.returnPhase === "dangerous" ? "dangerous" : "bypass";
						leavePlan(ctx, exitPlanTo(state, returnPhase));
					}
					const notes = formatApprovalNotes(approval.notes);
					pi.sendUserMessage(`用户已审批计划文件 \`${selected}\`（SHA-256: ${verified.hash}）。只按以下审批快照实施，不要重新读取文件替换审批内容。\n\n${verified.text}${notes}`);
					return;
				}
				throw new Error("用法：/plan [list|show|edit|implement|export]。不带参数仍切换 plan mode。");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				libraryBusy = false;
			}
		},
	});

	pi.registerCommand("plan-demo", {
		description: "Open a fixed Chinese plan review demo without changing plan mode",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
				ctx.ui.notify("/plan-demo 需要在交互式 TUI 中运行。", "info");
				return;
			}
			if (dialogOpen) {
				ctx.ui.notify("已有一个 plan 审阅窗口打开。", "info");
				return;
			}
			dialogOpen = true;
			try {
				const result = await showPlanReview(ctx.ui, DEMO_PLAN);
				if (!result) return;
				const label = result.kind === "revise" ? `演示结束：${result.comments.length} 条测试评论（未发送给模型）` : `demo: ${result.kind}`;
				ctx.ui.notify(label, "info");
			} finally {
				dialogOpen = false;
			}
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show the current permission mode (dangerous / bypass / plan)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			if (state.phase === "dangerous") {
				ctx.ui.notify("Current mode: ☢ dangerous (sandbox delete interception off, any permission). shift+tab returns to bypass.", "warning");
				return;
			}
			if (state.phase === "bypass") {
				ctx.ui.notify("Current mode: ⏵ bypass (sandbox delete interception on). shift+tab enters plan mode.", "info");
				return;
			}
			const lines: string[] = ["plan mode: plan (read-only)"];
			if (state.pending) {
				const first = state.pending.split("\n").find((line) => line.trim() !== "") ?? "";
				lines.push(`Pending plan: ${first.trim().slice(0, 60)} (${state.pending.split("\n").length} lines total)`);
			}
			if (state.planSummary) lines.push(`Summary: ${state.planSummary}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// =========================================================================
	// 自动进入：模型工具
	// =========================================================================

	/**
	 * 本次 run 里 brainstorming 技能在不在场（二选一闸的判定）。
	 *
	 * 读 `getBranch()` 而不是 `buildSessionProjection()`：分支是全量原始历史，压缩不会
	 * 把 run 窗口弄丢（投影会把旧消息换成摘要）；而 `getBranch()` 从当前叶子往上走，
	 * rewind / 分支导航之后被丢弃的分支天然不在里面，所以它也是分支正确的。
	 *
	 * 任何异常一律 fail-open（当作「没加载」）：误判成没加载只是回到旧行为（弹框），
	 * 误判成加载了会静默剥夺 plan mode，代价不对称。
	 */
	function brainstormingActive(ctx: ExtensionContext): boolean {
		try {
			return brainstormingLoadedInRun(messagesFromBranch(ctx.sessionManager.getBranch()));
		} catch {
			return false;
		}
	}

	if (!AUTO_DISABLED) {
		pi.registerTool({
			name: ENTER_TOOL,
			label: "Enter Plan Mode",
			description: ENTER_TOOL_DESCRIPTION,
			...planToolRenderers(ENTER_TOOL),
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "为什么这个任务需要先规划（一句话）" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				currentCtx = ctx;
				const reason = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : "";
				// brainstorming 互斥闸（在同意弹框**之前**）：本次 run 已加载 brainstorming 技能
				// 就不进 plan、也不打扰用户 —— 两套流程重叠，二选一（用户 2026-09-26 定）。
				// 判定失败一律 fail-open（照常弹框）：误判成「没加载」只是回到旧行为，
				// 误判成「加载了」会静默剥夺 plan mode，代价不对称。
				if (brainstormingActive(ctx)) {
					return {
						content: [
							{
								type: "text",
								text:
									`本次 run 已加载 brainstorming 技能，没有进入 plan mode。brainstorming 与 ${ENTER_TOOL} 二选一：` +
									"按技能自己的流程走（逐条澄清、给 2-3 个方案带取舍、在对话里给出设计并等用户批准；" +
									"架构级任务再写设计文档、转 writing-plans），不要再调用本工具。" +
									`用户若确实想用 plan mode，请他自己按 shift+tab 或 /plan。`,
							},
						],
						details: { phase: state.phase, brainstorming: true, consented: false },
					};
				}
				// 同意弹框只在模型路径：shift+tab / /plan / --plan 走 enter(ctx, "user")，
				// 那已经是用户自己的决定，再问一次是纯打扰。无 UI（pi -p）没有人会被打扰，
				// 也不弹 —— 保持既有 headless 行为。
				if (ctx.hasUI && !CONSENT_DISABLED) {
					// 正文（理由 + 两条路线说明）走 `text` 槽，标题与高亮选项仍归 pi 的 accent ——
					// `ui.select` 把整个 title 包成一段 accent，所以正文必须自己在 title 里上色
					// （内层显式颜色覆盖外层）。理由见 consent.ts。
					const choice = await ctx.ui.select(
						buildConsentTitle(
							ctx.ui.theme,
							{
								title: "Plan mode:",
								reason,
								planLine: `${CONSENT_PLAN}: explore read-only and propose a plan; work starts only after you approve`,
								implLine: `${CONSENT_IMPL}: skip planning and act on your instruction now`,
							},
							dialogFrame(),
						),
						[CONSENT_PLAN, CONSENT_IMPL],
					);
					// esc（undefined）当作否决，与 CC 的 “must consent” 一致 ——
					// 「嫌烦想跳过」这条最常见路径只需一个键。
					if (choice !== CONSENT_PLAN) {
						ctx.ui.notify("Skipped plan mode; implementing directly.", "info");
						return {
							content: [
								{
									type: "text",
									text: `用户选择直接实施，没有进入 plan mode。现在就按用户的指令动手，不要再调用 ${ENTER_TOOL}。`,
								},
							],
							details: { phase: state.phase, consented: false },
						};
					}
				}
				enterPlanMode(ctx, "model");
				return {
					content: [
						{
							type: "text",
							text: `已进入 plan mode（只读）。${reason ? `原因：${reason}。` : ""}\nedit / write 已停用，bash 里的写操作会被拦下。先读代码；需要用户拍板的选择用 ask_user_question 问；方案想清楚后调用 ${EXIT_TOOL} 提交。`,
						},
					],
					details: { phase: state.phase, consented: true },
				};
			},
		});
	}

	// plan 阶段唯一的出口：提交计划给用户审批
	pi.registerTool({
		name: EXIT_TOOL,
		label: "Submit Plan",
		...planToolRenderers(EXIT_TOOL),
		description:
			"在 plan mode 里把方案提交给用户审批。调用前不要试图改动任何文件。提交后用户决定批准（进入执行）还是打回（继续规划）。",
		parameters: Type.Object({
			plan: Type.String({
				description:
					"给用户看的完整方案（markdown）：要解决什么问题、现状与约束、打算改哪些文件各改什么、怎么验证。不要只写一串步骤标题。",
			}),
			slug: Type.String({
				description:
					"计划文档的文件名短名：小写英文单词 + 数字 + 连字符，3~5 个词概括这次任务，例如 `m5-entity-runtime`、`plan-doc-english-slug`。不要用中文、空格或标点（会被清洗掉，纯中文会退化成 `plan`）。最终文档名是 `<日期>-<slug>.md`。",
			}),
			summary: Type.Optional(Type.String({ description: "方案的一句话总结" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			if (state.phase !== "plan") {
				return {
					content: [{ type: "text", text: `现在不在 plan mode（当前：${state.phase}），不需要提交计划。` }],
					details: { accepted: false, phase: state.phase },
				};
			}
			const plan = typeof params.plan === "string" ? params.plan.trim() : "";
			if (plan === "") {
				return {
					content: [{ type: "text", text: "计划是空的。请写出完整方案（要解决什么、改哪些文件、怎么验证）再提交。" }],
					details: { accepted: false, phase: state.phase },
				};
			}
			const summary = typeof params.summary === "string" && params.summary.trim() !== "" ? params.summary.trim() : undefined;
			// slug 是文档名的来源；模型漏传时退回 summary（清洗后若全是中文仍会落到 `plan`）。
			const slug = typeof params.slug === "string" && params.slug.trim() !== "" ? params.slug.trim() : summary;

			Object.assign(state, submitPlan(state, plan, summary));
			persist();
			render(ctx);

			// TUI 走可滚动的 markdown 审阅（comment / send / approve 双击确认）；
			// 没有 custom 的宿主（单测、RPC）退回原来的 select，无 UI 时直接实施，
			// 比死锁好 —— 模型已经规划完，卡在这里只会让整个运行白跑。
			const epoch = sessionEpoch;
			const approval = await resolvePlanApproval(ctx, plan);
			if (_signal?.aborted || epoch !== sessionEpoch || state.phase !== "plan" || state.pending !== plan) {
				return { content: [{ type: "text", text: "审批已取消或会话已切换。未保存计划，也未开始实施。" }], details: { accepted: false } };
			}

			if (approval.kind === "reject" || approval.kind === "revise") {
				Object.assign(state, rejectPlan(state));
				persist();
				render(ctx);
				const text = approval.kind === "revise" ? buildRevisionMessage(approval.comments) : buildRejectedMessage();
				if (approval.kind === "revise") ctx.ui.notify("Comments sent. Waiting for a revised plan.", "info");
				return {
					content: [{ type: "text", text }],
					details: { accepted: false, phase: state.phase, comments: approval.kind === "revise" ? approval.comments : undefined },
				};
			}

			const docMode: PlanDocMode = approval.kind === "doc-only" ? "doc-only" : "execute-with-doc";
			const notes = approval.notes;
			let docPath: string;
			try {
				docPath = savePlanSnapshot(ctx.cwd, plan, slug);
			} catch (error) {
				ctx.ui.notify(`计划保存失败，仍留在 plan mode：${error instanceof Error ? error.message : String(error)}`, "error");
				return { content: [{ type: "text", text: "计划文件保存失败。仍在 plan mode；请告知用户并重试，不要实施。" }], details: { accepted: false, saveFailed: true } };
			}
			const approvedHash = hashText(plan);
			const returnPhase = state.returnPhase === "dangerous" ? "dangerous" : "bypass";
			leavePlan(ctx, exitPlanTo(state, returnPhase));
			if (ctx.hasUI) ctx.ui.notify(`Plan doc saved: ${docPath}`, "info");
			const approvalNotes = formatApprovalNotes(notes);
			const snapshot = `\n\n---\n\n审批快照（SHA-256: ${approvedHash}；文件：\`${docPath}\`）：\n\n${plan}${approvalNotes}`;
			const message = docMode === "doc-only"
				? `计划已保存到 \`${docPath}\`。用户选择只保存、不实施。现在停止并报告路径，不要修改代码。${snapshot}`
				: `计划已保存到 \`${docPath}\`。只按下方审批快照实施；不要从磁盘重新读取计划替换这个快照。${snapshot}`;
			return {
				content: [{ type: "text", text: message }],
				details: { accepted: true, docMode, docPath, approvedHash, approvedSnapshot: plan, notes },
			};
		},
	});

	// =========================================================================
	// 每轮注入上下文 + 拦截写操作
	// =========================================================================

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (state.phase !== "plan") return undefined;
		// 每轮重收一次：模型可能刚调过 enter_plan_mode，别的扩展也可能改过工具表
		if (!state.toolsBeforePlan) state.toolsBeforePlan = pi.getActiveTools();
		pi.setActiveTools(planToolSet(state.toolsBeforePlan));
		return {
			message: {
				customType: "plan-mode-context",
				content: buildPlanModeContext(ctx.cwd),
				display: false,
			},
		};
	});

	/**
	 * 第二道闸：拦截可识别的写类 bash 命令和直接 write 调用。
	 * 工具表里摘掉的是 edit / write / powershell，bash 还在，
	 * 所以这道钩子才是拦住 `echo x > f` / `git commit` / `npm install` 的地方。
	 * 拒绝原因作为工具错误结果回给模型 —— 这就是它能看到的反馈。
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase !== "plan") return undefined;

		if (event.toolName === "write") return { block: true, reason: `plan 阶段不能写文件。先用 ${EXIT_TOOL} 提交方案，等用户批准。` };

		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const verdict = inspectBashCommand(command);
		if (verdict.ok) return undefined;
		return {
			block: true,
			reason: `${verdict.reason}\n现在是 plan mode（只读阶段）：先把方案写清楚并用 ${EXIT_TOOL} 提交，等用户批准后写权限会恢复。`,
		};
	});


	// 不在 plan 态时（bypass 或 dangerous），把陈旧的 plan 上下文从模型上下文里过滤掉
	// （不该看到过期的指令）
	pi.on("context", async (event) => {
		if (state.phase === "plan") return undefined;
		return {
			messages: event.messages.filter((message) => {
				const type = (message as { customType?: string }).customType;
				return type !== "plan-mode-context" && type !== "plan-doc-write-context";
			}),
		};
	});
}

// =============================================================================
// 思考等级键改绑
// =============================================================================


function ensureThinkingKeyRebound(ctx: ExtensionContext): void {
	const path = keybindingsPath();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}

	const { value, outcome } = rebindThinkingKey(raw, path);
	if (!outcome.changed) {
		// 已经绑过（无论是谁绑的）→ 静默。只有「配置坏了、我们不敢动」才需要提醒。
		if (outcome.needsAttention === true && ctx.hasUI) {
			ctx.ui.notify(
				`plan mode takes over shift+tab, but the keybinding could not be rebound automatically (${outcome.reason}). ` +
					`Please rebind app.thinking.cycle to ${THINKING_FALLBACK_KEY} yourself (${path}).`,
				"warning",
			);
		}
		return;
	}

	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value, "utf8");
		if (ctx.hasUI) {
			ctx.ui.notify(
				`plan mode takes over shift+tab; the thinking-level cycle was rebound to ${THINKING_FALLBACK_KEY} (${path}, takes effect after /reload)`,
				"info",
			);
		}
	} catch {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`plan mode takes over shift+tab. Rebind app.thinking.cycle to ${THINKING_FALLBACK_KEY} in ${path}.`,
				"warning",
			);
		}
	}
}
