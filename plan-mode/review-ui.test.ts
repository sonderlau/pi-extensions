import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDocumentComment, formatLineComment, parsePlanLines } from "./review-lines.ts";
import { imeRequestLine, setImeWindowHandler } from "./ime-window.ts";
import { showPlanReview, commentTargetForSelection, isCommentEditorHit, planActionRows, reviewActions } from "./review-ui.ts";
import { CURSOR_MARKER, rgbColor, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

type ReviewUI = Parameters<typeof showPlanReview>[0];

async function reviewHarness(plan = "# title\nbody", width = 80, height = 24) {
	let component: ReturnType<Parameters<ReviewUI["custom"]>[0]> & { focused: boolean };
	let result: unknown;
	await showPlanReview({ custom: async (factory) => {
		const theme = {
			fg: (_slot: string, text: string) => text,
			bold: (text: string) => text,
			style: (text: string) => text,
			colors: { selectedBg: rgbColor(20, 20, 20), mdLink: rgbColor(40, 80, 120) },
		} as unknown as Theme;
		component = factory({ terminal: { rows: height }, requestRender() {} } as unknown as TUI, theme, {}, (value) => { result = value; }) as typeof component;
		component.focused = true;
		return undefined;
	} }, plan);
	const render = () => component.render(width);
	const click = (x: number, y: number) => component.handleMouse?.({ type: "click", button: "left", x, y, width, height } as TuiMouseEvent);
	const editorY = () => render().findIndex((line) => line.includes("Click or Tab") || line.includes("Editing · Tab")) + 1;
	return { render, click, editorY, key: (data: string) => component.handleInput(data), result: () => result };
}
it("restores the comment window input state without changing review shortcuts", async () => {
	const seen: string[] = [];
	setImeWindowHandler((window) => seen.push(window));
	try {
		const h = await reviewHarness();
		h.render();
		h.click(2, h.editorY());
		h.click(4, 2);
		h.key("\x1b");
		h.key("\x1b");
		assert.deepEqual(seen, ["browse", "comment", "browse", "prompt"]);
		assert.match(imeRequestLine("comment", 1_700_000_000_000), /^comment 1700000000\n$/);
	} finally {
		setImeWindowHandler(() => {});
	}
});

it("keyboard-only flow switches the input-method window: c → comment, enter → browse, s → prompt", async () => {
	const seen: string[] = [];
	setImeWindowHandler((window) => seen.push(window));
	try {
		const h = await reviewHarness();
		h.render();
		h.key("j");
		h.key("k");
		h.key("c");
		h.key("键盘输入意见");
		h.key("\r");
		h.key("s");
		assert.deepEqual(seen, ["browse", "comment", "browse", "prompt"]);
		assert.deepEqual(h.result(), { kind: "revise", comments: ["L1: 键盘输入意见"] });
	} finally {
		setImeWindowHandler(() => {});
	}
});

it("clicks into the resident editor and submits Chinese document comments", async () => {
	const h = await reviewHarness();
	assert.ok(!h.render().join("").includes(CURSOR_MARKER));
	h.click(2, h.editorY());
	assert.ok(h.render().join("").includes(CURSOR_MARKER));
	h.key("中文意见");
	h.key("\r");
	assert.ok(!h.render().join("").includes(CURSOR_MARKER));
	h.key("s");
	assert.deepEqual(h.result(), { kind: "revise", comments: ["Document: 中文意见"] });
});

function firstBodyNumber(lines: string[]): number {
	const match = (lines[2] ?? "").match(/(\d+)/);
	return match ? Number(match[1]) : -1;
}

it("u/d half-page and PageDown ease; a second press snaps; w is doc only", async () => {
	const plan = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
	const h = await reviewHarness(plan, 80, 24);
	const start = firstBodyNumber(h.render());
	h.key("d");
	const stepped = firstBodyNumber(h.render());
	assert.ok(stepped > start && stepped - start < 6, `half page should ease, moved ${stepped - start}`);
	h.key("d");
	const snapped = firstBodyNumber(h.render());
	assert.ok(snapped - stepped >= 6, `second d should snap, moved ${snapped - stepped}`);
	await new Promise((resolve) => setTimeout(resolve, 90));
	h.key("u");
	const up = firstBodyNumber(h.render());
	assert.ok(up < snapped && snapped - up < 6, `u should ease up, moved ${snapped - up}`);
	h.key("u");
	const page = await reviewHarness(plan, 80, 24);
	const pageStart = firstBodyNumber(page.render());
	page.key("\x1b[6~");
	const pageStepped = firstBodyNumber(page.render());
	assert.ok(pageStepped > pageStart && pageStepped - pageStart < 6);
	page.key("\x1b[6~");
	h.key("w");
	assert.equal(h.result(), undefined);
	h.key("w");
	assert.deepEqual(h.result(), { kind: "doc-only", notes: [] });
});

it("body clicks browse, and a draft keeps its original line while browsing", async () => {
	const h = await reviewHarness();
	h.render();
	h.click(4, 3);
	assert.ok(!h.render().join("").includes(CURSOR_MARKER));
	h.key("\t");
	h.key("第二行");
	h.render();
	h.click(4, 2);
	assert.ok(!h.render().join("").includes(CURSOR_MARKER));
	h.click(2, h.editorY());
	h.key("\r");
	h.key("s");
	assert.deepEqual(h.result(), { kind: "revise", comments: ["L2: 第二行"] });
});

it("Esc cancels without closing and multiline editors stay within the viewport", async () => {
	const h = await reviewHarness("", 40, 16);
	h.render();
	h.key("\t");
	h.key("\x1b[200~" + "长评论\n".repeat(20) + "\x1b[201~");
	assert.equal(h.render().length, 16);
	assert.ok(h.render().every((line) => visibleWidth(line) <= 40));
	h.key("\x1b");
	assert.equal(h.result(), undefined);
	assert.ok(!h.render().join("").includes(CURSOR_MARKER));
});

describe("comment target", () => {
	const sources = parsePlanLines("# title\nbody");

	it("uses the selected source line when one is selected", () => {
		assert.equal(commentTargetForSelection(1, sources), 2);
	});

	it("uses document scope before any line is selected", () => {
		assert.equal(commentTargetForSelection(-1, sources), 0);
	});
});

describe("resident comment editor", () => {
	it("only hits the editor's rendered rows", () => {
		assert.equal(isCommentEditorHit(10, 10, 3), true);
		assert.equal(isCommentEditorHit(12, 10, 3), true);
		assert.equal(isCommentEditorHit(13, 10, 3), false);
		assert.equal(isCommentEditorHit(9, 10, 3), false);
	});

	it("keeps browsing actions separate from editing actions", () => {
		assert.equal(reviewActions(false, false).find((action) => action.id === "doc")?.key, "w");
		assert.deepEqual(reviewActions(false, false).map((action) => action.id), ["comment", "send", "approve", "doc", "reject"]);
		assert.deepEqual(reviewActions(true, false).map((action) => action.id), ["save", "cancel"]);
	});

	it("reserves a hit row for every action row", () => {
		const rows = planActionRows(reviewActions(false, true), 24, 1);
		assert.ok(rows.length > 1);
		assert.equal(rows.flat().length, 5);
	});
});

describe("comment formatting", () => {
	it("distinguishes document comments from line comments", () => {
		assert.equal(formatDocumentComment("  全文需要补充背景  "), "Document: 全文需要补充背景");
		assert.equal(formatLineComment(2, "  这一行需要改  "), "L2: 这一行需要改");
	});
});
