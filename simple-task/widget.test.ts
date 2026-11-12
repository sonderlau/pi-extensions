/**
 * Tests for simple-task 的 widget 视口渲染 — 端到端：pi 自己的扩展加载器真加载本扩展，
 * 驱动一次 task_set 拿到扩展注册的 widget 工厂，再渲染真实行做断言。
 *
 * Run with:  PI_TEST_PI_ENTRY=<pi 库入口> node --test simple-task/widget.test.ts
 *
 * 为什么绕这一圈：视口的全部价值在「用户屏幕上滚不滚」，而屏幕上那几行是
 * 扩展自己注册的工厂 → `buildWidgetLines` 拼出来的。只看 `computeViewport` 的纯代数
 * 会漏掉「窗口滚了但渲染没跟上」这一半 —— 这里断言的是**整块的行**。
 *
 * 断言口径（用户 2026-11-10 定的三处改动，见 widget.ts 头注释）：
 *   - NF 图标（GLYPHS）：头部 tasks 图标、done 对勾圆、进行中加点圆、待办空心圆；
 *   - 折叠提示并入头部行尾（dim `↑N ↓N`，只显示非零侧），独立 `… N more` 行已删除；
 *   - 双列自适应：可见 ≥ 4 条且放得下时按行主序排两列，每格左对齐（右补空格），
 *     第二列起点固定 colWidth + 2；3 条以内 / 窄终端退回单列，与上游逐字节一致。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import { GLYPHS } from "./widget.ts";
import { widgetGaps } from "./gap.ts";

const { header: HEAD, pending: PEND, inProgress: RUN, done: DONE } = GLYPHS;

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
/** 与 render.test.ts / recap 的 index.test.ts 同一套查找逻辑：能真 import 的那个入口。 */
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
			// 不是符号链接 / 不存在：看下面的 shim 脚本
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

interface WidgetComponent {
	render(width: number): string[];
}
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface Harness {
	/** 注册过的 widget 工厂（每次 setWidget 都记一条，undefined = 摘掉 widget）。 */
	widgets: Array<{ key: string; factory?: WidgetFactory }>;
	/** 按 id 设置任务状态。 */
	update(id: number, status: "pending" | "in_progress" | "done"): Promise<void>;
	/** 建一份新的任务清单。 */
	set(texts: string[]): Promise<void>;
	/** 最近一次挂上的 widget 渲染出来的可见行（剥掉 ANSI）。 */
	lines(width?: number): string[];
	/** 直出最近一次挂上的组件（同样每帧新组件），用于喂给 gap.ts 的邻居判定。 */
	component(): WidgetComponent;
}

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 测试用的主题：颜色名原样写出来，断言直接看得见（同 web-search-tree 的做法）。 */
const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~${text}~`, bold: (t: string) => t };

async function loadHarness(): Promise<{ harness: Harness; cleanup: () => void }> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{
			extensions: Array<{
				handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
				tools: Map<string, { definition: { execute: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> } }>;
			}>;
			errors: Array<{ path: string; error: string }>;
			runtime: Record<string, unknown>;
		}>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-task-viewport-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, undefined);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 simple-task 扩展");

	// spinner 的 setInterval 在扩展闭包里 —— 不关掉的话 node 的事件循环不退出，
	// 整个 `node --test` 会挂到超时。这正是 session_shutdown 在真实会话里的职责。
	const shutdown = extension.handlers.get("session_shutdown")?.[0];
	assert.ok(shutdown, "扩展应当注册 session_shutdown 来停掉动画定时器");

	const widgets: Harness["widgets"] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		ui: {
			setWidget: (key: string, content: unknown) => {
				widgets.push({ key, factory: typeof content === "function" ? (content as WidgetFactory) : undefined });
			},
			notify: () => {},
		},
		sessionManager: { getBranch: () => [] },
	};
	loaded.runtime.appendEntry = () => {};

	const run = async (name: string, params: unknown): Promise<void> => {
		const definition = extension.tools.get(name)?.definition;
		assert.ok(definition, `扩展必须注册 ${name}`);
		await definition.execute("call-1", params, undefined, undefined, ctx);
	};

	const lastRendered = (): WidgetFactory => {
		for (let index = widgets.length - 1; index >= 0; index -= 1) {
			const entry = widgets[index];
			if (entry?.factory) return entry.factory;
		}
		throw new Error("还没有挂上 widget");
	};

	const harness: Harness = {
		widgets,
		async set(texts) {
			await run("task_set", { tasks: texts });
		},
		async update(id, status) {
			await run("task_update", { id, status });
		},
		component() {
			return lastRendered()(undefined, theme);
		},
		lines(width = 79) {
			return harness.component().render(width).map(plain);
		},
	};

	return {
		harness,
		cleanup: () => {
			void shutdown({}, ctx);
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

const TEXTS = Array.from({ length: 13 }, (_, index) => `Task ${index + 1}`);

test("13 项、前 10 完成、#11 进行中 → 8 条可见排两列（4 行），折叠计数并入头部", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 10; id += 1) await harness.update(id, "done");
		await harness.update(11, "in_progress");

		const lines = harness.lines();
		// colWidth：最宽格 `  ${DONE} ~#10 Task 10~` = 17 列；行主序：#4|#8、#5|#9、#6|#10、#7|#11
		assert.deepEqual(
			lines,
			[
				`${HEAD} 13 tasks (10 done, 1 in progress, 2 open)  ↑3 ↓2`,
				`  ${DONE} ~#4 Task 4~      ${DONE} ~#8 Task 8~`,
				`  ${DONE} ~#5 Task 5~      ${DONE} ~#9 Task 9~`,
				`  ${DONE} ~#6 Task 6~      ${DONE} ~#10 Task 10~`,
				`  ${DONE} ~#7 Task 7~      ${RUN} #11 Task 11…`,
			],
			"当前项 #11 必须落在末行右格，双列共 4 行",
		);
		// 第二列起点固定 = colWidth + gutter = 19：每个任务格都左对齐。
		for (const row of lines.slice(1)) assert.equal(row.slice(19).startsWith("  "), true, `右格没对齐在 19 列：${JSON.stringify(row)}`);
	} finally {
		cleanup();
	}
});

test("前 8 项还没完成时窗口停在开头（最小位移，不提前滚动）", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 7; id += 1) await harness.update(id, "done");
		await harness.update(8, "in_progress");

		const lines = harness.lines();
		assert.equal(lines[0], `${HEAD} 13 tasks (7 done, 1 in progress, 5 open)  ↓5`, "只有下方折叠 → 只显示 ↓");
		assert.equal(lines[1], `  ${DONE} ~#1 Task 1~    ${DONE} ~#5 Task 5~`, "第 8 项是锚点、还在窗口里 → 不滚，仍从 #1 起");
		assert.equal(lines[4], `  ${DONE} ~#4 Task 4~    ${RUN} #8 Task 8…`);
		assert.equal(lines.some((line) => line.includes("more")), false, "独立折叠行已删除，计数并入头部 ↑/↓");
	} finally {
		cleanup();
	}
});

test("全部完成时窗口停在末尾 —— 头部只显示 ↑5", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 13; id += 1) await harness.update(id, "done");

		const lines = harness.lines();
		assert.equal(lines[0], `${HEAD} 13 tasks (13 done)  ↑5`);
		assert.equal(lines[1], `  ${DONE} ~#6 Task 6~      ${DONE} ~#10 Task 10~`, "窗口贴住末尾 8 条，双列首行 #6|#10");
		assert.equal(lines[4], `  ${DONE} ~#9 Task 9~      ${DONE} ~#13 Task 13~`);
		assert.equal(lines.length, 5, "头部 + 4 行双列");
		assert.equal(lines[0].includes("↓"), false, "末尾没有隐藏项 → 不显示 ↓");
	} finally {
		cleanup();
	}
});

test("3 条短清单保持单列（折列门槛 4 条），无折叠提示", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS.slice(0, 3));
		await harness.update(1, "done");
		await harness.update(2, "in_progress");
		const lines = harness.lines();
		assert.deepEqual(lines, [
			`${HEAD} 3 tasks (1 done, 1 in progress, 1 open)`,
			`  ${DONE} ~#1 Task 1~`,
			`  ${RUN} #2 Task 2…`,
			`  ${PEND} #3 Task 3`,
		]);
		assert.equal(lines.some((line) => line.includes("more")), false, "无隐藏项时头部不带 ↑/↓");
	} finally {
		cleanup();
	}
});

test("4 条起折列（门槛刚好踩到）", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(["a", "b", "c", "d"]);
		const lines = harness.lines();
		assert.deepEqual(lines, [
			`${HEAD} 4 tasks (4 open)`,
			`  ${PEND} #1 a    ${PEND} #3 c`,
			`  ${PEND} #2 b    ${PEND} #4 d`,
		]);
	} finally {
		cleanup();
	}
});

test("中文标签按显示宽对齐：第二列起点与 ASCII 清单一致，不因全角字符错位", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(["画线框骨架", "读 pi-tui 文档", "调列间距", "补测试", "修 gap", "发版"]);
		await harness.update(1, "done");
		await harness.update(2, "done");
		await harness.update(3, "in_progress");

		const lines = harness.lines();
		// colWidth：最宽格 `  ${DONE} ~#2 读 pi-tui 文档~`（中文按 2 列）= 23 → 右格起点 25
		assert.deepEqual(
			lines,
			[
				`${HEAD} 6 tasks (2 done, 1 in progress, 3 open)`,
				`  ${DONE} ~#1 画线框骨架~        ${PEND} #4 补测试`,
				`  ${DONE} ~#2 读 pi-tui 文档~    ${PEND} #5 修 gap`,
				`  ${RUN} #3 调列间距…           ${PEND} #6 发版`,
			],
			"行主序：#1|#4、#2|#5、#3|#6；左格右补空格到 23 列",
		);
				// slice 按码元切、不等于显示列，对齐必须用 visibleWidth 量右格起点前的宽度。
		for (const row of lines.slice(1)) {
			const start = row.indexOf(`  ${PEND}`);
			assert.equal(visibleWidth(row.slice(0, start)), 25, `中文清单右格没对齐在 25 列：${JSON.stringify(row)}`);
		}
	} finally {
		cleanup();
	}
});

test("窄终端放不下两列时退回单列（2×最宽格 + 2 > 终端宽）", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(["画线框骨架", "读 pi-tui 文档", "调列间距", "补测试", "修 gap", "发版"]);
		await harness.update(1, "done");
		await harness.update(2, "done");
		await harness.update(3, "in_progress");

		const lines = harness.lines(24); // colWidth 23 → 2×23+2=48 > 24 → 单列
		assert.equal(lines.length, 7, "头部 + 6 条单列");
		assert.deepEqual(lines.slice(1), [
			`  ${DONE} ~#1 画线框骨架~`,
			`  ${DONE} ~#2 读 pi-tui 文档~`,
			`  ${RUN} #3 调列间距…`,
			`  ${PEND} #4 补测试`,
			`  ${PEND} #5 修 gap`,
			`  ${PEND} #6 发版`,
		]);
	} finally {
		cleanup();
	}
});

/**
 * gap.ts 的判定输入：widget 的顶行（头部）与底行（任务行）永远是有内容的非空行。
 * 把真 widget 组件原样喂给 widgetGaps（它只看 render 结果），不用重写一份假行。
 * 2026-11-10 起折叠提示并入头部，原来「折叠行不能被当成空行」的前提改为：
 * 头部行恒非空 → 这条钉住邻居空行逻辑不被回归。
 */
test("widget 顶/底行都是内容行，邻居照常补一行空行", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS.slice(0, 3));

		// 把真组件喂给 gap.ts（它只看 render 结果）—— 阶梯与行首缩进都在真实渲染里产生。
		const neighbour = { render: (): string[] => ["● 3 tasks", `  ${PEND} #1 其它块`], invalidate() {} };
		const self = harness.component();
		const below = { render: (): string[] => ["● other widget"], invalidate() {} };

		assert.deepEqual(
			widgetGaps({ children: [neighbour, self] }, self, 79),
			{ above: true, below: false },
			"上方邻居有内容 → 补一行",
		);
		// 同一个组件实例只能喂同一棵树（widgetGaps 按引用找自己）。
		const self2 = harness.component();
		assert.deepEqual(
			widgetGaps({ children: [self2, below] }, self2, 79),
			{ above: false, below: true },
			"下方邻居有内容 → 补一行",
		);
	} finally {
		cleanup();
	}
});
