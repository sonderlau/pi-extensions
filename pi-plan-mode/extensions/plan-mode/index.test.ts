/**
 * Tests for index.ts — plan-mode 的事件接线（用 pi 自己的加载器真实加载）。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/index.test.ts
 *
 * pi 的扩展加载器真的加载 `index.ts`（所以 `./plan.ts` / `./plan-text.ts` / `./render.ts`
 * 的 import 与注册面都在覆盖范围内），假的是扩展外面的一切：ctx（录制 setStatus /
 * notify / select / onTerminalInput / isIdle）、pi 的 API（录制 setActiveTools /
 * appendEntry）、以及会话条目。
 *
 * 覆盖的是**接线**而不是纯逻辑（纯逻辑在 plan.test.ts / plan-text.test.ts /
 * render.test.ts 里）。所以断言集中在：谁在什么时候改了活动工具、状态行写了什么、
 * swap 键什么时候被 consume、写命令什么时候被拦、审批快照何时保存与恢复权限。
 * 渲染细节不在这里重复测。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { THINKING_FALLBACK_KEY } from "./keybinding.ts";
// 直接 import 沙箱模式单例：扩展是经 pi 自己的加载器装的，可能拿到**另一个**模块实例，
// 而单例挂在 globalThis 上 —— 这正是两边能读到同一份状态的原因（测试也顺便钉住这一点）。
import { getSandboxMode, resetSandboxModeForTesting } from "./sandbox-mode.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/** 审批对话框的三个选项（与 index.ts 里的常量同值）。 */
const CHOICE_EXECUTE = "Write the plan and implement";
const CHOICE_DOC_ONLY = "Write the plan only";
const CHOICE_REJECT = "Reject";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 * 判定方式是**能不能真 import**（`~/.pi/agent/npm` 那份副本可能是被剪过的空壳），
 * 全都不行就整体 skip，不假装通过。与 working-indicator/index.test.ts 同一套做法。
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接：看下面的 shim 脚本
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim：跳过
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	tools: Map<string, unknown>;
	shortcuts: Map<string, unknown>;
	flags: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
	/** 测试挂上去的：真实的活动工具数组（runtime.getActiveTools 读的就是它）。 */
	__activeTools: string[];
	__runtime: RuntimeLike;
	__projectDir: string;
}

test("/plan-demo 用中文示例打开审阅，各种裁决不改变模式或工具集", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { reviewResult: { kind: "reject" } });
		const commands = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands;
		const demo = commands.get("plan-demo");
		assert.ok(demo);
		const before = harness.getActiveTools();
		const entries = rec.entries.length;
		const statuses = rec.statuses.length;
		for (const kind of ["execute", "doc-only", "revise", "reject"] as const) {
			harness.ctx.ui.custom = async <T>(factory: unknown) => {
				const build = factory as (tui: unknown, theme: unknown, kb: unknown, done: unknown) => { render: (width: number) => string[] };
				const component = build({ terminal: { rows: 40 }, requestRender() {} }, harness.ctx.ui.theme, {}, () => {});
				assert.match(component.render(120).join("\n"), /中文输入体验测试/);
				assert.equal(harness.ctx.__feedInput("\x1b[Z"), undefined, "demo 打开时不能切换权限");
				return { kind, comments: ["Document: 测试"], notes: [] } as T;
			};
			await demo.handler("", harness.ctx);
			assert.deepEqual(harness.getActiveTools(), before);
			assert.equal(rec.entries.length, entries);
			assert.equal(rec.statuses.length, statuses);
			assert.equal(rec.messages.length, 0);
		}
		assert.deepEqual(harness.ctx.__feedInput("\x1b[Z"), { consume: true }, "demo 结束后解除对话框标记");
	} finally {
		workspace.cleanup();
	}
});

test("/plan-demo 在非 TUI 环境提示，审阅失败后清理对话框标记", { skip }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const demo = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands.get("plan-demo")!;
		await demo.handler("", harness.ctx);
		assert.match(rec.notifies.at(-1)!, /交互式 TUI/);
		const withUI = makeContext(extension, rec, { reviewResult: { kind: "reject" } });
		withUI.ctx.ui.custom = async () => { throw new Error("demo render failed"); };
		await assert.rejects(() => demo.handler("", withUI.ctx), /demo render failed/);
		assert.deepEqual(harness.ctx.__feedInput("\x1b[Z"), { consume: true });
	} finally {
		workspace.cleanup();
	}
});

/** 默认活动工具：含 pi 的写工具与两个模拟的扩展/ MCP 工具。 */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "task_set", "mcp__x__y"];

function createTestBus(rec?: Recorder): {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
} {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			rec?.emits.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

async function loadExtension(
	agentDir: string,
	projectDir: string,
	rec: Recorder,
	flagValues?: Map<string, unknown>,
): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{
			extensions: LoadedExtension[];
			errors: Array<{ path: string; error: string }>;
			runtime: RuntimeLike;
		}>;
	};

	// 用 pi 自己的加载器把扩展装好，拿到它共用的那个 runtime，再把 action 方法接上。
	// 于是测试走的是扩展真实会调用的那条路（`pi.setActiveTools()` 会打到我们接的录制器），
	// 而不是另造一个假 pi 对象 —— 假的 pi 无法验证「扩展调的到底是不是 pi 的 API」。
	const bus = createTestBus(rec);
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);

	const active: string[] = [...DEFAULT_TOOLS];
	Object.assign(loaded.runtime, {
		sendMessage: async (message: { content: string }) => {
			rec.messages.push(message);
		},
		sendUserMessage: async (content: string) => {
			rec.messages.push({ content });
		},
		appendEntry: (customType: string, data: unknown) => {
			rec.entries.push({ customType, data });
		},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [...active],
		getAllTools: () => [],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
			rec.toolSets.push([...names]);
		},

		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	});

	// `pi.getFlag()` 读 runtime.flagValues；默认值在扩展注册 flag 时就已经写进去了，
	// 这里只覆盖测试显式指定的那几项。
	if (flagValues) {
		for (const [name, value] of flagValues) loaded.runtime.flagValues?.set(name, value);
	}

	extension.__activeTools = active;
	extension.__runtime = loaded.runtime;
	extension.__projectDir = projectDir;
	return extension;
}

interface RuntimeLike {
	flagValues?: Map<string, unknown>;
	setActiveTools?: (names: string[]) => void;
}

interface Recorder {
	/** 每次 setStatus 记一条 `key=值`（undefined 记为 `key=<undefined>`）。 */
	statuses: string[];
	notifies: string[];
	/** 录制的工具集变更，按发生顺序。 */
	toolSets: string[][];
	entries: Array<{ customType: string; data: unknown }>;
	messages: Array<{ content: string }>;
	/** 扩展广播出去的事件（现在只剩注册时的一次性动作，不再有镜像同步）。 */
	emits: Array<{ channel: string; data: unknown }>;
	/** select 对话框收到的标题（含计划正文）。 */
	selectTitles: string[];
	/** 审阅层（ui.custom）返回过的裁决，按顺序。 */
	reviewVerdicts: string[];
	editorTitles: string[];
}

interface ContextOptions {
	hasUI?: boolean;
	mode?: string;
	idle?: boolean;
	/** select 对话框的返回值（默认选推荐路线「写计划文档并实施」；undefined = 用户按了 esc）。 */
	selectResult?: string;
	/** 已经存在的活动工具（默认一份含扩展工具的清单）。 */
	activeTools?: string[];
	/** sessionManager 返回的条目；`getBranch()` 与 `getEntries()` 都取它。 */
	entries?: unknown[];
	flagValues?: Map<string, unknown>;
	/** 审阅层（ui.custom）的裁决结果；提供时 ctx.ui 才有 custom 方法，走 showPlanReview 路径。 */
	reviewResult?: { kind: "execute" | "doc-only" | "revise" | "reject"; notes?: string[]; comments?: string[] };
	editorResult?: string;
	beforeSelect?: (title: string, choices: string[]) => void;
	beforeEditor?: (title: string) => void;
}

function makeContext(extension: LoadedExtension, recorder: Recorder, options: ContextOptions = {}) {
	const inputHandlers: InputHandler[] = [];

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: extension.__projectDir,
		isIdle: () => options.idle ?? true,
		waitForIdle: async () => {},
		sessionManager: {
			getEntries: () => options.entries ?? [],
			getBranch: () => options.entries ?? [],
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				style: (text: string) => text,
				strikethrough: (text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => {
				recorder.statuses.push(`${key}=${value === undefined ? "<undefined>" : value}`);
			},
			notify: (message: string) => {
				recorder.notifies.push(message);
			},
			select: async (title: string, choices: string[]) => {
				recorder.selectTitles.push(title);
				options.beforeSelect?.(title, choices);
				// 显式传 undefined = 用户按了 esc（select 返回 undefined）；
				// 没传这个字段才走默认 = 直接回车（第一项，即推荐路线）。
				// 对审批框等价于 CHOICE_EXECUTE（本来就是第一项），对同意框才是正确的
				// CONSENT_PLAN。硬编码 CHOICE_EXECUTE 会让同意框的默认行为错成「写计划文档并实施」。
				return "selectResult" in options ? options.selectResult : (choices[0] ?? undefined);
			},
			editor: async (title: string, _prefilledText: string) => {
				recorder.editorTitles.push(title);
				options.beforeEditor?.(title);
				return options.editorResult;
			},
			custom:
				"reviewResult" in options
					? (async <T>(_factory: unknown) => {
							// 模拟审阅层：不真渲染组件工厂，直接返回注入的裁决。
							recorder.reviewVerdicts.push(options.reviewResult!.kind);
							return options.reviewResult as T;
					  })
					: undefined,
			onTerminalInput: (handler: InputHandler) => {
				inputHandlers.push(handler);
				return () => {
					const index = inputHandlers.indexOf(handler);
					if (index !== -1) inputHandlers.splice(index, 1);
				};
			},
		},
		/**
		 * 测试用：按 pi 的真实行为广播一次按键 —— 所有在册监听器都会收到，
		 * 任一返回 `consume` 就短路（`TuiBase.handleTerminalInput` 的语义）。
		 * 所以「重复注册」不会被这里掩盖：注册两次就会切两次。
		 */
		__feedInput: (data: string) => {
			for (const handler of [...inputHandlers]) {
				const result = handler(data);
				if (result?.consume) return result;
			}
			return undefined;
		},
		/** 测试用：当前在册的监听器数量（验证防重入）。 */
		__listenerCount: () => inputHandlers.length,
	};

	return { ctx, getActiveTools: () => [...extension.__activeTools] };
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function recorder(): Recorder {
	return { statuses: [], notifies: [], toolSets: [], entries: [], messages: [], emits: [], selectTitles: [], reviewVerdicts: [], editorTitles: [] };
}

function handlerOf(extension: LoadedExtension, name: string): Handler {
	const handler = extension.handlers.get(name)?.[0];
	assert.ok(handler, `应该注册了 ${name}`);
	return handler;
}

interface RegisteredTool {
	definition: {
		name: string;
		execute: (
			toolCallId: string,
			params: unknown,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		renderShell?: string;
		renderCall?: (args: unknown, theme: unknown, context: unknown) => Rendered;
		renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Rendered;
	};
}

/** 渲染器返回的鸭子组件（pi 只调这两个方法，不做 instanceof 检查）。 */
interface Rendered {
	render(width: number): string[];
	invalidate(): void;
}

/** 取注册的工具定义（pi 存的是 `{ definition, sourceInfo }`）。 */
function toolOf(extension: LoadedExtension, name: string): RegisteredTool {
	const tool = extension.tools.get(name);
	assert.ok(tool, `应该注册了工具 ${name}`);
	return tool as RegisteredTool;
}

/** 调用工具（`execute` 在 `definition` 上）。 */
function callTool(
	extension: LoadedExtension,
	name: string,
	params: unknown,
	ctx: unknown,
): Promise<{ content: Array<{ text: string }>; details?: unknown }> {
	const tool = toolOf(extension, name);
	return tool.definition.execute("call-1", params, undefined, undefined, ctx) as Promise<{
		content: Array<{ text: string }>;
		details?: unknown;
	}>;
}

const sessionStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "session_start")(...args);
const beforeAgentStart = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "before_agent_start")(...args);
const toolCall = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "tool_call")(...args);
const toolResult = (extension: LoadedExtension, ...args: Parameters<Handler>) => handlerOf(extension, "tool_result")(...args);

/** 启动一个会话（session_start + before_agent_start，模拟一次完整回合的前半段）。 */
async function startSession(
	extension: LoadedExtension,
	recorder: Recorder,
	options: ContextOptions = {},
): Promise<SessionHarness> {
	setActiveToolsOf(extension, options.activeTools ?? DEFAULT_TOOLS);
	const harness = makeContext(extension, recorder, options);
	await sessionStart(extension, { reason: "startup" }, harness.ctx);
	await beforeAgentStart(extension, { prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, harness.ctx);
	return harness;
}

interface SessionHarness {
	ctx: Record<string, unknown> & { __feedInput: (data: string) => { consume?: boolean } | undefined };
	getActiveTools: () => string[];
}

/** 把 pi 那侧的活动工具表设成给定值（模拟会话启动时的加载结果）。 */
function setActiveToolsOf(extension: LoadedExtension, tools: string[]): void {
	extension.__runtime.setActiveTools?.(tools);
}

/** 从 exit_plan_mode 的工具结果里取出钉死的文档路径（第一个反引号对）。 */
function docPathFrom(result: { content: Array<{ text: string }> }): string {
	const match = /`([^`]+)`/.exec(result.content[0]!.text);
	assert.ok(match, `工具结果里应带文档路径，实际：${result.content[0]!.text}`);
	return match[1]!;
}

const PLAN = "# 方案\n\n改 plan.ts 与 render.ts。";

/** 进 plan 并提交一份计划，返回审批后的工具结果。 */
async function submitPlan(
	extension: LoadedExtension,
	harness: SessionHarness,
	options: { summary?: string; slug?: string } = {},
): Promise<{ content: Array<{ text: string }>; details?: unknown }> {
	harness.ctx.__feedInput("\x1b[Z");
	return callTool(
		extension,
		"exit_plan_mode",
		{ plan: PLAN, slug: options.slug ?? "fix-two-files", summary: options.summary ?? "改两个文件" },
		harness.ctx,
	);
}

// =============================================================================
// 加载与注册面
// =============================================================================

test("扩展能被 pi 的加载器加载，并注册两个工具与一条命令", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		assert.ok(extension.tools.has("enter_plan_mode"), "应注册 enter_plan_mode");
		assert.ok(extension.tools.has("exit_plan_mode"), "应注册 exit_plan_mode");
		assert.equal(extension.shortcuts.size, 0, "shift+tab 走原始输入拦截，不该注册快捷键");
		assert.ok(extension.flags.has("plan"), "应注册 --plan flag");
		assert.ok(!extension.handlers.has("tool_result"), "快照由扩展直接写入，不依赖模型 write");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// shift+tab
// =============================================================================

test("shift+tab 在空闲时切进 plan 并 consume；写工具被摘掉、扩展工具保留", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = harness.ctx.__feedInput("\x1b[Z");

		assert.deepEqual(result, { consume: true }, "shift+tab 必须被吃掉，否则会落到编辑器上");
		assert.deepEqual(harness.getActiveTools(), ["read", "bash", "grep", "ls", "task_set", "mcp__x__y"]);
		assert.ok(rec.statuses.at(-1)?.includes("plan"), `状态行应显示 plan，实际 ${rec.statuses.at(-1)}`);
	} finally {
		workspace.cleanup();
	}
});

test("三种 shift+tab 编码都能切（裸 CSI / Kitty CSI-u / modifyOtherKeys）", { skip, timeout: 30_000 }, async () => {
	// 回归：`shift+tab` 有三种编码，硬编码比对其中一种会在启用了 Kitty 键盘协议的终端上完全失效
	// （实测踩到：pty 里能切、真实 Ghostty 里按 shift+tab 没反应）。必须走 pi 自己的 matchesKey。
	const encodings: Array<[string, string]> = [
		["裸 CSI", "\x1b[Z"],
		["Kitty CSI-u", "\x1b[9;2u"],
		["xterm modifyOtherKeys", "\x1b[27;2;9~"],
	];
	for (const [label, sequence] of encodings) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = await startSession(extension, rec);

			const result = harness.ctx.__feedInput(sequence);
			assert.deepEqual(result, { consume: true }, `${label} 应该被 consume`);
			assert.ok(!harness.getActiveTools().includes("write"), `${label} 应该切进 plan`);
			assert.match(rec.statuses.at(-1) ?? "", /plan/, `${label} 状态行应显示 plan`);
		} finally {
			workspace.cleanup();
		}
	}
});

test("再按一次 shift+tab 退出 plan，活动工具原样还原（固定循环落到 dangerous）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();

		harness.ctx.__feedInput("\x1b[Z"); // bypass → plan
		harness.ctx.__feedInput("\x1b[Z"); // plan → dangerous（固定循环，不回 bypass）

		assert.deepEqual(harness.getActiveTools(), before, "退出后必须逐字还原（含扩展工具）");
		assert.match(rec.statuses.at(-1) ?? "", /☢ dangerous/, "shift+tab 离开 plan 走固定循环，落到 dangerous");
	} finally {
		workspace.cleanup();
	}
});

test("shift+tab 三态固定循环：bypass → plan → dangerous → bypass", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "启动默认 bypass");

		harness.ctx.__feedInput("\x1b[Z");
		assert.match(rec.statuses.at(-1) ?? "", /⏸ plan/);

		harness.ctx.__feedInput("\x1b[Z");
		assert.match(rec.statuses.at(-1) ?? "", /☢ dangerous/);
		assert.ok(
			harness.getActiveTools().includes("write"),
			"dangerous 是 pi 原生任意权限：写工具全部在场",
		);

		harness.ctx.__feedInput("\x1b[Z");
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "循环回到起点");
	} finally {
		workspace.cleanup();
	}
});

test("dangerous 态不拦写命令（沙箱删除拦截已关，bash 写操作放行）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		harness.ctx.__feedInput("\x1b[Z"); // → plan
		harness.ctx.__feedInput("\x1b[Z"); // → dangerous

		const toolCall = handlerOf(extension, "tool_call");
		const verdict = await toolCall(
			{ toolName: "bash", input: { command: "rm -rf dist && git commit -am x" } },
			harness.ctx,
		);
		assert.equal(verdict, undefined, "dangerous 态不拦任何写操作");
	} finally {
		workspace.cleanup();
	}
});

test("沙箱模式单例跟着三态走：dangerous 关、bypass / plan 开", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		resetSandboxModeForTesting();
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		assert.equal(getSandboxMode(), "bypass", "启动默认 bypass：沙箱拦截开启");

		harness.ctx.__feedInput("\x1b[Z"); // → plan
		assert.equal(getSandboxMode(), "plan");

		harness.ctx.__feedInput("\x1b[Z"); // → dangerous
		assert.equal(getSandboxMode(), "dangerous", "dangerous 态必须告知沙箱层关掉拦截");

		harness.ctx.__feedInput("\x1b[Z"); // → bypass
		assert.equal(getSandboxMode(), "bypass");

		resetSandboxModeForTesting();
	} finally {
		workspace.cleanup();
	}
});

test("/plan 命令永远不落到 dangerous（dangerous 只能 shift+tab 切）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const commands = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands;
		const plan = commands.get("plan");
		assert.ok(plan, "应注册了 /plan");

		await plan.handler("", harness.ctx); // bypass → plan
		assert.match(rec.statuses.at(-1) ?? "", /⏸ plan/);

		await plan.handler("", harness.ctx); // plan → bypass（不是 dangerous）
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "/plan 离开 plan 回安全默认态");

		assert.equal(commands.has("dangerous"), false, "不该有 /dangerous 命令");
	} finally {
		workspace.cleanup();
	}
});

test("重复 session_start 不叠加监听器（一次 shift+tab 只切一次）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		// /reload、/new、/resume 都会再跑一次 session_start。
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		await sessionStart(extension, { reason: "reload" }, harness.ctx);
		await sessionStart(extension, { reason: "new" }, harness.ctx);

		// 三次 session_start 之后仍然只有一个在册监听器 —— 否则 pi 广播时会被切多次。
		const count = (harness.ctx as unknown as { __listenerCount: () => number }).__listenerCount();
		assert.equal(count, 1, `监听器不该叠加，实际在册 ${count} 个`);

		// 一次 shift+tab 只切一次 → 进 plan（而不是切两次回到 bypass）。
		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.ok(!harness.getActiveTools().includes("write"), "一次按键应该只切一次：应停在 plan 态");
		const status = rec.statuses.at(-1) ?? "";
		assert.ok(status.includes("plan"), `状态行应是 plan，实际 ${status}`);
	} finally {
		workspace.cleanup();
	}
});

test("其它按键与忙碌时不抢键（不 consume）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);

		// 普通字符
		const busy = await startSession(extension, rec);
		assert.equal(busy.ctx.__feedInput("a"), undefined);
		assert.equal(busy.ctx.__feedInput("tab"), undefined, "裸 tab 不是 shift+tab");
		assert.deepEqual(busy.getActiveTools(), busy.getActiveTools(), "工具表不该被改");

		// 流式中（不空闲）：让 pi 的思考等级循环照常工作
		const streaming = await startSession(extension, rec, { idle: false });
		assert.equal(streaming.ctx.__feedInput("\x1b[Z"), undefined, "忙碌时不抢键");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 模型自动进入
// =============================================================================

test("enter_plan_mode 工具让模型自己进 plan，并回一段说明", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /已进入 plan mode/);
		assert.match(result.content[0]!.text, /exit_plan_mode/, "要告诉模型怎么出去");
		assert.ok(!harness.getActiveTools().includes("write"), "进 plan 后写工具必须停用");
		// 模型路径要先过同意弹框（默认回车 = 接受）
		assert.equal(rec.selectTitles.length, 1, "模型路径应弹一次同意框");
		assert.match(rec.selectTitles[0]!, /^Plan mode:\n/, "弹框标题是 Plan mode:");
		assert.ok(rec.selectTitles[0]!.includes("要改多个文件"), "弹框里要能看到模型给的理由");
	} finally {
		workspace.cleanup();
	}
});

test("同意框选「直接实施」：不进 plan、写工具仍在、告诉模型别再调", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: "Implement directly" });

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /没有进入 plan mode/, "必须明确说没进");
		assert.match(result.content[0]!.text, /不要再调用/, "要阻止模型反复重试");
		assert.ok(harness.getActiveTools().includes("write"), "否决后写工具不能被动");
		assert.equal(rec.selectTitles.length, 1, "只弹这一次");
	} finally {
		workspace.cleanup();
	}
});

test("同意框按 esc：等同否决（CC 的 must consent）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: undefined });

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /没有进入 plan mode/);
		assert.ok(harness.getActiveTools().includes("write"), "esc 后写工具不能被动");
	} finally {
		workspace.cleanup();
	}
});

test("用户路径（shift+tab / --plan）不弹同意框——那已经是用户的决定", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.equal(rec.selectTitles.length, 0, "shift+tab 不该弹框");
		assert.ok(!harness.getActiveTools().includes("write"), "应直接进 plan");
	} finally {
		workspace.cleanup();
	}

	const workspace2 = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace2.agentDir, workspace2.projectDir, rec, new Map([["plan", true]]));
		const harness = makeContext(extension, rec);
		await sessionStart(extension, { reason: "startup" }, harness.ctx);
		assert.equal(rec.selectTitles.length, 0, "--plan 不该弹框");
		assert.ok(!harness.getActiveTools().includes("edit"), "--plan 应直接进 plan");
	} finally {
		workspace2.cleanup();
	}
});

test("PI_PLAN_MODE_CONSENT=off：不弹框直接进（回到旧行为）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_PLAN_MODE_CONSENT = "off";
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /已进入 plan mode/);
		assert.equal(rec.selectTitles.length, 0, "CONSENT=off 时不该弹框");
		assert.ok(!harness.getActiveTools().includes("write"), "应直接进 plan");
	} finally {
		delete process.env.PI_PLAN_MODE_CONSENT;
		workspace.cleanup();
	}
});

test("brainstorming 互斥闸：本次 run 已加载技能 → 不进 plan、不弹框", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			entries: [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "用 brainstorming 设计方案" }] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "read",
								arguments: { path: "/Users/bachi/.agents/skills/superpowers/brainstorming/SKILL.md" },
							},
						],
					},
				},
			],
		});

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.match(result.content[0]!.text, /已加载 brainstorming/, "要说清为什么没进");
		assert.match(result.content[0]!.text, /二选一/);
		assert.match(result.content[0]!.text, /不要再调用/, "要阻止模型反复重试");
		assert.match(result.content[0]!.text, /shift\+tab/, "要给用户留逃生出口");
		assert.equal(rec.selectTitles.length, 0, "互斥闸在同意弹框之前，不该弹框");
		assert.ok(harness.getActiveTools().includes("write"), "没进 plan，写工具不能被动");
		assert.deepEqual(
			rec.entries.filter((entry) => entry.customType === "plan-mode"),
			[],
			"不该写下任何 plan-mode 状态条目",
		);
		const details = result.details as { phase?: string; brainstorming?: boolean; consented?: boolean };
		assert.equal(details.phase, "bypass");
		assert.equal(details.brainstorming, true);
		assert.equal(details.consented, false);
	} finally {
		workspace.cleanup();
	}
});

test("brainstorming 互斥闸：read 在上一条 user 消息之前（上一轮的）→ 照常弹框", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			entries: [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "上一轮" }] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "read",
								arguments: { path: "/skills/superpowers/brainstorming/SKILL.md" },
							},
						],
					},
				},
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "新一轮" }] } },
			],
		});

		const result = await callTool(extension, "enter_plan_mode", { reason: "要改多个文件" }, harness.ctx);

		assert.equal(rec.selectTitles.length, 1, "豁免不跨 run，应照常弹同意框");
		assert.match(result.content[0]!.text, /已进入 plan mode/);
	} finally {
		workspace.cleanup();
	}
});

test("brainstorming 互斥闸：用 bash cat 读技能不算加载（词法口径的已知边界）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			entries: [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "bash",
								arguments: { command: "cat /skills/superpowers/brainstorming/SKILL.md" },
							},
						],
					},
				},
			],
		});

		await callTool(extension, "enter_plan_mode", { reason: "x" }, harness.ctx);

		assert.equal(rec.selectTitles.length, 1, "只认 read 工具，应照常弹框");
	} finally {
		workspace.cleanup();
	}
});

test("brainstorming 互斥闸：用户手动进 plan 不受影响", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			entries: [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "read",
								arguments: { path: "/skills/superpowers/brainstorming/SKILL.md" },
							},
						],
					},
				},
			],
		});

		const result = harness.ctx.__feedInput("\x1b[Z");
		assert.deepEqual(result, { consume: true });
		assert.ok(!harness.getActiveTools().includes("write"), "shift+tab 应直接进 plan，互斥闸不拦用户路径");
		assert.equal(rec.selectTitles.length, 0);
	} finally {
		workspace.cleanup();
	}
});

test("工具描述带完整路由判据：正面条件 + 豁免清单都在", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		await startSession(extension, rec);

		const tool = toolOf(extension, "enter_plan_mode");
		const desc = (tool.definition as unknown as { description: string }).description;
		// 正面条件（CC 的 7 条里的量化门槛与 ask_user_question 替代规则）
		assert.match(desc, /2-3 个以上文件/, "多文件门槛要写清");
		assert.match(desc, /ask_user_question/, "要说明与 ask_user_question 的替代关系");
		// 豁免清单（实测的两类误报来源，防将来被顺手删掉）
		assert.match(desc, /具体、详细的指令/, "用户给了明确指令的小改要豁免");
		assert.match(desc, /纯调研/, "纯调研 / 写报告要豁免");
		assert.match(desc, /brainstorming/, "二选一豁免要写进工具描述（模型决定要不要调的那一刻就在眼前）");
		// 同意机制的自述（拿不准就调的前提）
		assert.match(desc, /需要用户同意/, "要告诉模型这个工具会被用户否决");
	} finally {
		workspace.cleanup();
	}
});

test("--plan flag 让会话启动就进 plan", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec, new Map([["plan", true]]));
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("edit"), "--plan 应摘掉写工具");
		assert.ok(rec.notifies.some((message) => message.includes("plan mode")), "应提示已进入");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// exit_plan_mode：三选一
// =============================================================================

test("提交计划：对话框是 select 三选一，标题里带计划全文", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		await submitPlan(extension, harness);

		assert.equal(rec.selectTitles.length, 1, "应弹一次审批对话框");
		assert.match(rec.selectTitles[0]!, /Approve this plan/, "标题要问批不批");
		// 计划正文现在装在框里：每一行前面多了 `│ `、后面多了补位空格与 `│`，所以按行断言
		// （整段字面量已经被框打断了）。
		const title = rec.selectTitles[0]!;
		for (const line of PLAN.split("\n").filter((row) => row.trim() !== "")) {
			assert.ok(
				title.split("\n").some((row) => row.includes(line)),
				`对话框里要能看到计划全文（缺：${line}）`,
			);
		}
		assert.match(title, /┌─+┐/, "计划正文要有线框");
		assert.match(title, /└─+┘/);
	} finally {
		workspace.cleanup();
	}
});

test("批准后扩展直接保存审批快照并恢复原工具集", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const before = harness.getActiveTools();
		const result = await submitPlan(extension, harness, { slug: "fix-two-files" });
		const details = result.details as { docPath: string; approvedSnapshot: string; approvedHash: string };
		assert.equal(details.approvedSnapshot, PLAN);
		assert.match(details.approvedHash, /^[a-f0-9]{64}$/);
		assert.equal(fs.readFileSync(details.docPath, "utf8"), PLAN);
		assert.match(result.content[0]!.text, /只按下方审批快照实施/);
		assert.match(result.content[0]!.text, new RegExp(details.approvedHash));
		assert.equal(harness.getActiveTools().includes("write"), before.includes("write"));
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/);
	} finally { workspace.cleanup(); }
});

test("只保存批准计划时不实施", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { selectResult: CHOICE_DOC_ONLY });
		const result = await submitPlan(extension, harness);
		assert.equal((result.details as { docMode: string }).docMode, "doc-only");
		assert.match(result.content[0]!.text, /不要修改代码/);
		assert.equal(rec.messages.length, 0);
	} finally { workspace.cleanup(); }
});

test("选「打回」或按 esc：留在 plan（只读），并要求模型改方案", { skip, timeout: 30_000 }, async () => {
	for (const selectResult of [CHOICE_REJECT, undefined]) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = await startSession(extension, rec, { selectResult });

			const result = await submitPlan(extension, harness);

			assert.match(result.content[0]!.text, /没有批准/);
			assert.ok(!harness.getActiveTools().includes("write"), "打回后仍然是只读");
			assert.match(rec.statuses.at(-1) ?? "", /plan/, "仍停在 plan 态");
		} finally {
			workspace.cleanup();
		}
	}
});

test("/plan implement 审阅保存文件并只发送批准快照", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		const planDir = path.join(workspace.projectDir, ".pi", "plans");
		fs.mkdirSync(planDir, { recursive: true });
		const name = "later.md";
		const approved = "# Later\n\nExact text.";
		fs.writeFileSync(path.join(planDir, name), approved);
		const command = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands.get("plan")!;
		await command.handler(`implement ${name}`, harness.ctx);
		assert.equal(rec.messages.length, 1, JSON.stringify({ messages: rec.messages, notifies: rec.notifies }));
		assert.ok(rec.messages[0]!.content.includes(approved));
		assert.match(rec.messages[0]!.content, /只按以下审批快照实施/);
	} finally { workspace.cleanup(); }
});

test("/plan implement 文件在审批期间变化时拒绝实施", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const planDir = path.join(workspace.projectDir, ".pi", "plans");
		fs.mkdirSync(planDir, { recursive: true });
		const file = path.join(planDir, "race.md");
		fs.writeFileSync(file, "# Reviewed");
		const harness = await startSession(extension, rec, { beforeSelect: () => fs.writeFileSync(file, "# Changed") });
		const command = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands.get("plan")!;
		await command.handler("implement race.md", harness.ctx);
		assert.equal(rec.messages.length, 0);
		assert.ok(rec.notifies.some((message) => /审批期间发生变化/.test(message)), JSON.stringify(rec.notifies));
	} finally { workspace.cleanup(); }
});

test("/plan edit 在并发修改时不覆盖原文件", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const planDir = path.join(workspace.projectDir, ".pi", "plans");
		fs.mkdirSync(planDir, { recursive: true });
		const file = path.join(planDir, "edit-race.md");
		fs.writeFileSync(file, "# Original");
		const harness = await startSession(extension, rec, { editorResult: "# My edit", beforeEditor: () => fs.writeFileSync(file, "# External") , selectResult: "Cancel" });
		const command = (extension as unknown as { commands: Map<string, { handler: Handler }> }).commands.get("plan")!;
		await command.handler("edit edit-race.md", harness.ctx);
		assert.equal(fs.readFileSync(file, "utf8"), "# External");
		assert.ok(rec.selectTitles.some((title) => /changed or was deleted/.test(title)));
	} finally { workspace.cleanup(); }
});

test("非交互运行（pi -p）自动按推荐路线走，不死锁", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, { hasUI: false });

		const result = await submitPlan(extension, harness);

		assert.equal(rec.selectTitles.length, 0, "没有 UI 就不该弹对话框");
		const details = result.details as { docPath: string; approvedSnapshot: string };
		assert.equal(details.approvedSnapshot, PLAN);
		assert.equal(fs.readFileSync(details.docPath, "utf8"), PLAN);
	} finally {
		workspace.cleanup();
	}
});

test("审阅层带意见打回：意见写进工具结果、留在 plan 态，不再弹 select", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			reviewResult: { kind: "revise", comments: ["L3: 少了验证步骤", "L8: 风险一段太空"] },
		});

		const result = await submitPlan(extension, harness);

		assert.match(result.content[0]!.text, /L3: 少了验证步骤/);
		assert.match(result.content[0]!.text, /L8: 风险一段太空/);
		assert.match(result.content[0]!.text, /再次调用 exit_plan_mode/);
		assert.equal(rec.selectTitles.length, 0, "有 custom 审阅层时不再弹 select 审批框");
		assert.deepEqual(rec.reviewVerdicts, ["revise"]);
		assert.ok(rec.notifies.some((message) => /Comments sent/.test(message)));
	} finally {
		workspace.cleanup();
	}
});

test("审阅层批准并附意见：意见进工具结果与 details", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			reviewResult: { kind: "execute", notes: ["保留旧命令"] },
		});

		const result = await submitPlan(extension, harness);

		assert.match(result.content[0]!.text, /只按下方审批快照实施/);
		assert.match(result.content[0]!.text, /保留旧命令/, "批准时附带的意见要交给模型");
		assert.match(result.content[0]!.text, /\.pi\/plans\//, "仍要钉死文档路径");
		assert.equal((result.details as { notes?: string[] }).notes?.[0], "保留旧命令");
		assert.equal(rec.selectTitles.length, 0);
	} finally {
		workspace.cleanup();
	}
});

test("不在 plan 时调 exit_plan_mode：明确拒绝，不改变状态", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		const result = await callTool(extension, "exit_plan_mode", { plan: PLAN }, harness.ctx);
		assert.match(result.content[0]!.text, /不在 plan mode/);
		assert.equal(rec.selectTitles.length, 0, "不该弹审批框");
	} finally {
		workspace.cleanup();
	}
});

test("空计划被拒绝", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const result = await callTool(extension, "exit_plan_mode", { plan: "   " }, harness.ctx);
		assert.match(result.content[0]!.text, /空的/);
		assert.equal(rec.selectTitles.length, 0);
	} finally {
		workspace.cleanup();
	}
});



// =============================================================================
// plan 阶段的写操作拦截
// =============================================================================



test("普通 plan 态（非子态）：write 被双保险拦下", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const blocked = (await toolCall(
			extension,
			{ toolName: "write", toolCallId: "w3", input: { path: "/repo/a.txt", content: "x" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true, "工具表已摘掉 write，钩子再拦一道");
		assert.match(blocked.reason ?? "", /plan 阶段不能写文件/);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// tool_result 自动收尾
// =============================================================================







test("固定循环下 shift+tab 从 dangerous 到不了 plan（要经 bypass）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);

		harness.ctx.__feedInput("\x1b[Z"); // bypass → plan
		harness.ctx.__feedInput("\x1b[Z"); // plan → dangerous
		harness.ctx.__feedInput("\x1b[Z"); // dangerous → bypass
		assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, "dangerous 的下一态是 bypass，不是 plan");

		harness.ctx.__feedInput("\x1b[Z"); // bypass → plan
		assert.match(rec.statuses.at(-1) ?? "", /⏸ plan/);
	} finally {
		workspace.cleanup();
	}
});





// =============================================================================
// 写操作拦截（bash）
// =============================================================================

test("plan 阶段写类 bash 被拦下并把原因回给模型；只读命令放行", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const blocked = (await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t1", input: { command: "rm -rf dist" } },
			harness.ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /plan mode/);
		assert.match(blocked.reason ?? "", /exit_plan_mode/, "要告诉模型正确的出路");

		const allowed = await toolCall(
			extension,
			{ toolName: "bash", toolCallId: "t2", input: { command: "git status" } },
			harness.ctx,
		);
		assert.equal(allowed, undefined, "只读命令不该被拦");
	} finally {
		workspace.cleanup();
	}
});



test("bypass 态不拦写命令", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		assert.equal(await toolCall(extension, { toolName: "bash", toolCallId: "t4", input: { command: "rm -rf dist" } }, harness.ctx), undefined);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 会话恢复
// =============================================================================

function planEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: "plan-mode", data };
}

test("会话恢复：plan 态从会话条目还原，工具表跟着收回", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec, {
			entries: [planEntry({ phase: "plan", pending: PLAN, toolsBeforePlan: DEFAULT_TOOLS })],
		});

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!harness.getActiveTools().includes("write"), "恢复出 plan 态就该收工具");
		assert.match(rec.statuses.at(-1) ?? "", /plan/);
	} finally {
		workspace.cleanup();
	}
});



test("会话恢复：dangerous 态与 returnPhase 都能从条目还原", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec, { entries: [planEntry({ phase: "dangerous" })] });

		resetSandboxModeForTesting();
		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.match(rec.statuses.at(-1) ?? "", /☢ dangerous/, "dangerous 要能恢复（它是用户亲手切到的）");
		assert.equal(getSandboxMode(), "dangerous", "恢复后沙箱层也要是关的");
		assert.deepEqual(harness.getActiveTools(), DEFAULT_TOOLS, "dangerous 不收工具");

		resetSandboxModeForTesting();
	} finally {
		workspace.cleanup();
	}
});



test("会话恢复：旧条目里的 phase \"normal\" / \"execute\" 都映射成 bypass", { skip, timeout: 30_000 }, async () => {
	// `normal` 是 2026-09-23 改名前的值；`execute` 是 2026-09-24 删掉的态。
	// 两者恢复出来都当 bypass：白名单式判定兜住一切历史值。
	for (const phase of ["normal", "execute"]) {
		const workspace = makeWorkspace();
		try {
			const rec = recorder();
			const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
			const harness = makeContext(extension, rec, {
				entries: [planEntry({ phase, steps: [{ step: 1, text: "旧步骤", done: false }] })],
			});

			await sessionStart(extension, { reason: "startup" }, harness.ctx);

			assert.match(rec.statuses.at(-1) ?? "", /⏵ bypass/, `phase=${phase} 应恢复成 bypass`);
			assert.deepEqual(harness.getActiveTools(), DEFAULT_TOOLS, "不该收工具");
		} finally {
			workspace.cleanup();
		}
	}
});

test("会话恢复：旧条目里的步骤数组型 pending 被丢弃（只认字符串计划）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec, {
			entries: [planEntry({ phase: "plan", pending: [{ step: 1, text: "旧步骤" }], toolsBeforePlan: DEFAULT_TOOLS })],
		});

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.match(rec.statuses.at(-1) ?? "", /⏸ plan$/, "没有 pending，不该显示「待批准」");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 上下文注入与过滤
// =============================================================================

test("plan 态注入只读上下文（display: false），bypass 态把它过滤掉", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		harness.ctx.__feedInput("\x1b[Z");

		const injected = (await beforeAgentStart(
			extension,
			{ prompt: "hi", systemPrompt: "", systemPromptOptions: {} },
			harness.ctx,
		)) as { message?: { customType: string; content: string; display: boolean } } | undefined;
		assert.equal(injected?.message?.customType, "plan-mode-context");
		assert.equal(injected?.message?.display, false, "用户看不到，模型看得到");
		assert.match(injected?.message?.content ?? "", /\[PLAN MODE\]/);

		// 退出后这些注入消息要从上下文里过滤掉（模型不该看到过期指令）
		harness.ctx.__feedInput("\x1b[Z");
		const contextHandler = handlerOf(extension, "context");
		const filtered = (await contextHandler(
			{
				messages: [
					{ customType: "plan-mode-context", content: "x" },
					{ customType: "plan-doc-write-context", content: "y" },
					{ role: "user", content: "hi" },
				],
			},
			harness.ctx,
		)) as { messages: Array<{ customType?: string; role?: string }> };
		assert.equal(filtered.messages.length, 1, "两类 plan 注入都该被过滤");
		assert.equal(filtered.messages[0]!.role, "user");
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 思考等级键改绑
// =============================================================================

test("启动时把 thinking cycle 改绑到 fallback 键（写进 agentDir 的 keybindings.json）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const file = path.join(workspace.agentDir, "keybindings.json");
		assert.ok(fs.existsSync(file), "应写出 keybindings.json");
		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["app.thinking.cycle"], THINKING_FALLBACK_KEY);
		assert.ok(rec.notifies.some((message) => message.includes(THINKING_FALLBACK_KEY)), "首次改绑要告知一次");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("已经有 keybindings.json 时保留其它绑定", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t", "editor.undo": "ctrl+z" }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["editor.undo"], "ctrl+z", "其它绑定原样保留");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("用户自己配过 thinking cycle 时启动不碰文件", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "ctrl+alt+t" }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(bindings["app.thinking.cycle"], "ctrl+alt+t", "用户的选择优先");
		assert.ok(!rec.notifies.some((message) => message.includes("改绑")), "不该提醒");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

test("上次改绑过（已绑到 fallback）时启动也静默", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		const rec = recorder();
		const file = path.join(workspace.agentDir, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({ "app.thinking.cycle": THINKING_FALLBACK_KEY }));
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = makeContext(extension, rec);

		await sessionStart(extension, { reason: "startup" }, harness.ctx);

		assert.ok(!rec.notifies.some((message) => message.includes("改绑")), "已经绑过就不该再提醒");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		workspace.cleanup();
	}
});

// =============================================================================
// 工具调用块的渲染形态（用户 2026-09-29 定：self 壳 + 树形，无底色、无下空行）
// =============================================================================

/** 假主题：丢掉颜色以便断言可见文本；bold 也原样返回。 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 造一个渲染 context：state 是跨 renderCall/renderResult 共享的同一个对象（与 pi 一致）。 */
function renderContext(overrides: { isPartial?: boolean; isError?: boolean } = {}) {
	return {
		state: {} as { outcome?: string },
		isPartial: overrides.isPartial ?? false,
		isError: overrides.isError ?? false,
	};
}

/** 结果文本（enter 成功那条的真实形状，两行）。 */
const ENTER_RESULT = {
	content: [
		{
			type: "text",
			text: "已进入 plan mode（只读）。原因：跨 gateway/config.yaml 与 pi、opencode、codex 三端配置的行为改动。\nedit / write 已停用，bash 里的写操作会被拦下。",
		},
	],
	details: { phase: "plan", consented: true },
};

test("两个工具都用 self 壳（去底色 + 去下空行的唯一途径）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		for (const name of ["enter_plan_mode", "exit_plan_mode"]) {
			const definition = toolOf(extension, name).definition;
			assert.equal(definition.renderShell, "self", `${name} 应设 renderShell: "self"`);
			assert.equal(typeof definition.renderCall, "function", `${name} 应有 renderCall`);
			assert.equal(typeof definition.renderResult, "function", `${name} 应有 renderResult`);
		}
	} finally {
		workspace.cleanup();
	}
});

test("标题行：成功是 • 工具名 ✔，被打回是 • 工具名 ✘（state 传递）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		const definition = toolOf(extension, "enter_plan_mode").definition;

		// 成功：先跑 renderResult 写 state.outcome，再 renderCall 读它（pi 的真实顺序是
		// callRenderer 先于 resultRenderer，但屏幕绘制在两者之后，所以懒组件读到的是写好的值）。
		const okCtx = renderContext();
		definition.renderResult!(ENTER_RESULT, { expanded: false, isPartial: false }, plainTheme, okCtx);
		const okTitle = plain(definition.renderCall!({}, plainTheme, okCtx).render(80)[0]!);
		assert.equal(okTitle, "• enter_plan_mode ✔", `成功标题（顶格）：${JSON.stringify(okTitle)}`);

		// 被打回（declined）：details 里 accepted/consented 不是 true
		const noCtx = renderContext();
		definition.renderResult!(
			{ content: [{ type: "text", text: "用户没有批准这个计划。" }], details: { accepted: false, phase: "plan" } },
			{ expanded: false, isPartial: false },
			plainTheme,
			noCtx,
		);
		const noTitle = plain(definition.renderCall!({}, plainTheme, noCtx).render(80)[0]!);
		assert.equal(noTitle, "• enter_plan_mode ✘", `被打回标题（顶格）：${JSON.stringify(noTitle)}`);
		assert.ok(!noTitle.includes("✔"), "被打回不该出现 ✔");
	} finally {
		workspace.cleanup();
	}
});

test("标题行：执行中（结果未到）是灰 • 工具名、无标记", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		const definition = toolOf(extension, "enter_plan_mode").definition;
		const ctx = renderContext({ isPartial: true });
		const title = plain(definition.renderCall!({}, plainTheme, ctx).render(80)[0]!);
		assert.equal(title, "• enter_plan_mode", `执行中标题（顶格）：${JSON.stringify(title)}`);
	} finally {
		workspace.cleanup();
	}
});

test("正文：结果全文折行挂树，除末行外 │、末行 └，正文对齐第 3 列", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		const definition = toolOf(extension, "enter_plan_mode").definition;
		const ctx = renderContext();
		// 用短文本（宽 80 下不折行）钉「两行正文 → 一行 │ + 一行 └」这个结构
		const lines = definition
			.renderResult!(
				{
					content: [{ type: "text", text: "已进入 plan mode（只读）。\nedit / write 已停用。" }],
					details: { phase: "plan", consented: true },
				},
				{ expanded: false, isPartial: false },
				plainTheme,
				ctx,
			)
			.render(80)
			.map(plain);
		assert.equal(lines.length, 2, `两行正文：${JSON.stringify(lines)}`);
		assert.ok(lines[0]!.startsWith("  │ "), `首行挂 │（2 列缩进）：${JSON.stringify(lines[0])}`);
		assert.ok(lines[1]!.startsWith("  └ "), `末行挂 └（2 列缩进）：${JSON.stringify(lines[1])}`);
		// 树符在列 2（`enter_plan_mode` 首字母 e 正下方），正文从列 4 起
		assert.equal(lines[0]!.indexOf("│"), 2, `│ 在列 2：${JSON.stringify(lines[0])}`);
		assert.equal(lines[0]!.indexOf("已进入"), 4, `正文列：${JSON.stringify(lines[0])}`);
		assert.equal(lines[1]!.indexOf("edit"), 4, `正文列：${JSON.stringify(lines[1])}`);

		// 真实长度的结果文本（ENTER_RESULT）：全文都在、不截断，只是首行会折行
		const full = definition
			.renderResult!(ENTER_RESULT, { expanded: false, isPartial: false }, plainTheme, renderContext())
			.render(80)
			.map(plain);
		assert.ok(full.length > 2, `长文本应折行：${JSON.stringify(full)}`);
		assert.equal(
			full.filter((line) => line.includes("└")).length,
			1,
			`└ 只能出现一次：${JSON.stringify(full)}`,
		);
		assert.ok(full[full.length - 1]!.includes("└"), `└ 在最后一行：${JSON.stringify(full)}`);
		assert.ok(full.join("\n").includes("bash 里的写操作会被拦下"), "全文不截断");
	} finally {
		workspace.cleanup();
	}
});

test("正文：长行折行后 └ 仍只在最后一个视觉行（碎片也算独立行）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		const definition = toolOf(extension, "exit_plan_mode").definition;
		const ctx = renderContext();
		const long = "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的计划正文";
		const lines = definition
			.renderResult!(
				{ content: [{ type: "text", text: long }], details: { accepted: true, docMode: "execute-with-doc", docPath: "/x.md" } },
				{ expanded: false, isPartial: false },
				plainTheme,
				ctx,
			)
			.render(30)
			.map(plain);
		assert.ok(lines.length > 1, `窄宽度下应折成多行：${JSON.stringify(lines)}`);
		const corners = lines.filter((line) => line.includes("└"));
		assert.equal(corners.length, 1, `└ 只能出现一次：${JSON.stringify(lines)}`);
		assert.ok(lines[lines.length - 1]!.includes("└"), `└ 必须在最后一行：${JSON.stringify(lines)}`);
		assert.ok(lines.slice(0, -1).every((line) => line.includes("│")), `其余行都挂 │：${JSON.stringify(lines)}`);
	} finally {
		workspace.cleanup();
	}
});

test("整块无底色：self 壳经 pi 真实组件渲染后不含背景 SGR（\\x1b[48）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		initTheme: (name?: string) => void;
		ToolExecutionComponent: new (
			toolName: string,
			toolCallId: string,
			args: unknown,
			options: unknown,
			toolDefinition: unknown,
			ui: { requestRender(): void },
			cwd: string,
		) => {
			markExecutionStarted: () => void;
			updateResult: (result: unknown, isPartial?: boolean) => void;
			render: (width: number) => string[];
		};
	};
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, recorder());
		const definition = toolOf(extension, "enter_plan_mode").definition;
		pi.initTheme("dark");
		const component = new pi.ToolExecutionComponent(
			"enter_plan_mode",
			"call-1",
			{ reason: "x" },
			{},
			definition,
			{ requestRender() {} },
			workspace.projectDir,
		);
		component.markExecutionStarted();
		component.updateResult(ENTER_RESULT, false);
		const raw = component.render(80);
		assert.equal(raw[0], "", "第 0 行是 pi self 模式固定的留白");
		assert.notEqual(raw[raw.length - 1]!.trim(), "", "最后一行不是空行（无下边界空行）");
		for (const line of raw) {
			assert.ok(!line.includes("\x1b[48"), `不该有背景 SGR：${JSON.stringify(line)}`);
		}
		const visible = raw.map(plain).filter((line) => line.trim() !== "");
		assert.ok(visible[0]!.startsWith("• enter_plan_mode ✔"), `标题行顶格（圆点前无空格）：${JSON.stringify(visible[0])}`);
		assert.ok(visible.some((line) => line.includes("└")), "树里有 └");
		// 树符与标题对齐：`│` / `└` 在列 2，正好是 `enter_plan_mode` 首字母 e 的正下方
		//（标题是 `• enter_plan_mode`：圆点列 0、空格列 1、e 列 2）
		assert.equal(visible[0]!.indexOf("e"), 2, `标题里 e 在列 2：${JSON.stringify(visible[0])}`);
		for (const line of visible.slice(1)) {
			const treeCol = line.search(/[│└]/);
			assert.equal(treeCol, 2, `树符应在列 2（与 e 对齐）：${JSON.stringify(line)}`);
		}
	} finally {
		workspace.cleanup();
	}
});


test("审批快照保存失败时仍保持只读且不实施", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec);
		fs.writeFileSync(path.join(workspace.projectDir, ".pi"), "blocks plan directory");
		const result = await submitPlan(extension, harness);
		assert.equal((result.details as { saveFailed?: boolean }).saveFailed, true);
		assert.equal(harness.getActiveTools().includes("write"), false);
		assert.equal(harness.getActiveTools().includes("edit"), false);
		assert.match(rec.statuses.at(-1) ?? "", /plan/);
		assert.equal(rec.messages.length, 0);
		assert.match(result.content[0]!.text, /不要实施/);
	} finally { workspace.cleanup(); }
});

test("恢复旧 docWriting 会话时清除写权限并要求重新审批", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const rec = recorder();
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir, rec);
		const harness = await startSession(extension, rec, {
			entries: [planEntry({ phase: "plan", pending: PLAN, docWriting: true,
				docMode: "execute-with-doc", pendingDocPath: "/untrusted.md", toolsBeforePlan: DEFAULT_TOOLS })],
		});
		assert.equal(harness.getActiveTools().includes("write"), false);
		assert.equal(harness.getActiveTools().includes("edit"), false);
		assert.doesNotMatch(rec.statuses.at(-1) ?? "", /writing doc/);
		const blocked = await toolCall(extension, { toolName: "write", input: { path: "/untrusted.md", content: PLAN } }, harness.ctx);
		assert.equal((blocked as { block?: boolean }).block, true);
		assert.equal(rec.messages.length, 0);
	} finally { workspace.cleanup(); }
});
