/**
 * 计划审阅层。
 *
 * 全屏模式下 ↑↓ / 滚轮默认滚的是聊天记录（`tui.altScreen.lineUp`），编辑区里的
 * 组件抢不到。所以这里用盖住屏幕的 overlay，自己选行、自己滚动。标题只改颜色和
 * 加粗，不改字号。意见按原文行号写成 `L150: ...` 交回模型。
 * 底部操作是可点击按钮；悬停时填色、加下划线，并把左空格换成 `>`。键盘快捷键仍可用。
 * `approve` / `doc only` / `reject` 要在 1.2 秒内操作两次才会通过。键盘和鼠标是同一种操作，可以混着来。
 * 浏览：j/k 一行，u/d 半页，PageUp/PageDown 整页。半页和整页走同一套滑动，连按则跳。
 * doc only 原来占着 d，改到 w（写文档、不实施）；按钮上会显示这个键。
 * 评论编辑里的 esc 只取消这一条，不走二次确认。
 *
 * 本目录（~/Dev/pi-agent/pi-plan-mode）是 vendored 的 plan-mode：基底 @bachi/pi-coder 2.5.6
 * + 本审阅层。settings 里用 `!extensions/plan-mode/**` 排除了 npm 包里的原版，所以这里
 * 就是运行时唯一加载的 plan-mode。上游更新时把新版的 plan-mode 目录拷进来，重放
 * index.ts/plan-text.ts 里的 review 集成（resolvePlanApproval + buildRevisionMessage +
 * formatApprovalNotes）即可。不再盖 npm 包的文件。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	mixColors,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { activateImeWindow, beginImeReview } from "./ime-window.ts";
import { createPageScroll } from "../ui-polish/smooth-page-scroll.ts";
import { formatDocumentComment, formatLineComment, headingText, parsePlanLines, type PlanSourceLine } from "./review-lines.ts";

export type PlanReviewResult =
	| { kind: "execute" | "doc-only"; notes: string[] }
	| { kind: "revise"; comments: string[] }
	| { kind: "reject" };

type ReviewActionId = "comment" | "send" | "approve" | "doc" | "reject" | "save" | "cancel";
type ConfirmActionId = "approve" | "doc" | "reject";

interface ReviewAction {
	id: ReviewActionId;
	key: string;
	label: string;
	enabled: boolean;
	tone: Slot;
	pending?: boolean;
}

interface ButtonHit {
	id: ReviewActionId;
	y: number;
	x: number;
	width: number;
	enabled: boolean;
}

type ReviewUI = {
	custom: <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => {
			render: (width: number) => string[];
			invalidate: () => void;
			handleInput: (data: string) => void;
			handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
		},
		options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
	) => Promise<T>;
};

interface VisualRow {
	source: number;
	text: string;
}

export async function showPlanReview(ui: ReviewUI, plan: string): Promise<PlanReviewResult | undefined> {
	const sources = parsePlanLines(plan);
	beginImeReview();
	return ui.custom<PlanReviewResult | undefined>(
		(tui, theme, _kb, done) => {
			const finish = (value?: PlanReviewResult) => {
				activateImeWindow("prompt");
				done(value);
			};
			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);
			const comments = new Map<number, string[]>();
			let commenting = false;
			let focused = false;
			let selected = -1;
			let commentTarget = 0; // 0 denotes a document comment; source lines are 1-based.
			let editorTop = 0;
			let editorHeight = 3;
			let scroll = 0;
			let cached: string[] | undefined;
			let cachedWidth = 0;
			let rows: VisualRow[] = [];
			let hoverId: ReviewActionId | undefined;
			let viewWidth = 80;
			let bodyRows = 4;
			let buttonHits: ButtonHit[] = [];
			let confirmId: ConfirmActionId | undefined;
			let confirmUntil = 0;
			let confirmTimer: ReturnType<typeof setTimeout> | undefined;

			function syncEditorFocus(): void {
				editor.focused = focused && commenting;
			}
			function setCommenting(next: boolean): void {
				commenting = next;
				activateImeWindow(next ? "comment" : "browse");
				syncEditorFocus();
			}
			function refresh(): void {
				cached = undefined;
				tui.requestRender();
			}
			function notes(): string[] {
				const lines: string[] = [];
				for (const number of [...comments.keys()].sort((a, b) => a - b)) {
					for (const text of comments.get(number) ?? []) lines.push(number === 0 ? formatDocumentComment(text) : formatLineComment(number, text));
				}
				return lines;
			}
			editor.onSubmit = (value) => {
				const text = value.trim();
				if (text) {
					const list = comments.get(commentTarget) ?? [];
					list.push(text);
					comments.set(commentTarget, list);
				}
				editor.setText("");
				setCommenting(false);
				refresh();
			};

			function move(delta: number): void {
				if (sources.length === 0) return;
				selected = selected < 0 ? (delta < 0 ? sources.length - 1 : 0) : Math.max(0, Math.min(sources.length - 1, selected + delta));
				reveal();
				refresh();
			}
			function reveal(): void {
				const index = rows.findIndex((row) => row.source === selected);
				if (index < 0) return;
				const view = bodyHeight();
				if (index < scroll) scroll = index;
				else if (index >= scroll + view) scroll = index - view + 1;
			}
			function confirmArmed(): ConfirmActionId | undefined {
				return confirmId && Date.now() < confirmUntil ? confirmId : undefined;
			}
			function clearConfirm(): void {
				confirmId = undefined;
				confirmUntil = 0;
				if (!confirmTimer) return;
				clearTimeout(confirmTimer);
				confirmTimer = undefined;
			}
			function armConfirm(id: ConfirmActionId): void {
				clearConfirm();
				confirmId = id;
				confirmUntil = Date.now() + CONFIRM_MS;
				confirmTimer = setTimeout(() => {
					confirmTimer = undefined;
					confirmId = undefined;
					confirmUntil = 0;
					refresh();
				}, CONFIRM_MS);
				refresh();
			}
			function requestConfirm(id: ConfirmActionId): void {
				if (confirmArmed() !== id) {
					armConfirm(id);
					return;
				}
				activate(id);
			}
			function currentActions(): ReviewAction[] {
				return reviewActions(commenting, notes().length > 0, confirmArmed());
			}
			function prefixText(): string {
				return " ";
			}
			function bodyHeight(): number {
				const term = tui.terminal.rows;
				const buttons = planActionRows(currentActions(), Math.max(8, viewWidth), visibleWidth(prefixText())).length;
				return Math.max(1, term - 3 - buttons - editorHeight);
			}
			function activate(id: ReviewActionId): void {
				const action = currentActions().find((item) => item.id === id);
				if (!action?.enabled) return;
				clearConfirm();
				hoverId = undefined;
				switch (id) {
					case "reject":
						finish({ kind: "reject" });
						return;
					case "approve":
						finish({ kind: "execute", notes: notes() });
						return;
					case "doc":
						finish({ kind: "doc-only", notes: notes() });
						return;
					case "send":
						finish({ kind: "revise", comments: notes() });
						return;
					case "comment":
						if (!editor.getText()) commentTarget = commentTargetForSelection(selected, sources);
						setCommenting(true);
						refresh();
						return;
					case "save":
						editor.onSubmit?.(editor.getText());
						return;
					case "cancel":
						editor.setText("");
						setCommenting(false);
						refresh();
						return;
				}
			}

			function handleInput(data: string): void {
				if (matchesKey(data, Key.tab)) {
					if (!commenting) return activate("comment");
					setCommenting(false);
					refresh();
					return;
				}
				if (commenting) {
					if (matchesKey(data, Key.escape)) return activate("cancel");
					editor.handleInput(data);
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) return requestConfirm("reject");
				if (matchesKey(data, "a")) return requestConfirm("approve");
				if (matchesKey(data, "w")) return requestConfirm("doc");
				if (confirmId) {
					clearConfirm();
					refresh();
				}
				if (matchesKey(data, "s")) return activate("send");
				if (matchesKey(data, "c") || matchesKey(data, Key.enter)) return activate("comment");
				if (matchesKey(data, Key.up) || matchesKey(data, "k")) return move(-1);
				if (matchesKey(data, Key.down) || matchesKey(data, "j")) return move(1);
				if (matchesKey(data, "u")) return scrollBy(-halfPage());
				if (matchesKey(data, "d")) return scrollBy(halfPage());
				if (matchesKey(data, Key.pageUp)) return scrollBy(-bodyHeight());
				if (matchesKey(data, Key.pageDown)) return scrollBy(bodyHeight());
				if (matchesKey(data, Key.home)) {
					selected = 0;
					scroll = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.end)) {
					selected = Math.max(0, sources.length - 1);
					reveal();
					refresh();
				}
			}

			function halfPage(): number {
				return Math.max(1, Math.floor(bodyHeight() / 2));
			}
			const easeScroll = createPageScroll((delta) => applyScroll(delta));
			function scrollBy(delta: number): void {
				easeScroll(delta);
			}
			function applyScroll(delta: number): void {
				const max = Math.max(0, rows.length - bodyHeight());
				scroll = Math.max(0, Math.min(max, scroll + delta));
				const visible = rows.slice(scroll, scroll + bodyHeight());
				if (selected >= 0 && !commenting && visible.length > 0 && !visible.some((row) => row.source === selected)) {
					selected = delta < 0 ? visible[0]!.source : visible[visible.length - 1]!.source;
				}
				refresh();
			}

			function hitAt(x: number, y: number): ButtonHit | undefined {
				return buttonHits.find((hit) => hit.y === y && x >= hit.x && x < hit.x + hit.width);
			}
			function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "wheel") {
					scrollBy(event.wheelDelta && event.wheelDelta < 0 ? -3 : 3);
					return { handled: true };
				}
				if (event.type === "move") {
					const next = hitAt(event.x, event.y)?.id;
					if (next === hoverId) return { handled: true, render: false };
					hoverId = next;
					cached = undefined;
					return { handled: true, render: true };
				}
				if (event.type === "press" && event.button === "left") {
					return { handled: true, focus: true, render: false };
				}
				if (event.type === "click" && event.button === "left") {
					const hit = hitAt(event.x, event.y);
					if (hit && isConfirmAction(hit.id)) {
						const closing = confirmArmed() === hit.id;
						requestConfirm(hit.id);
						// done() hides this overlay; focus:true makes pi-tui setFocus the removed component and keys never reach the editor.
						return { handled: true, focus: !closing, render: true };
					}
					if (hit) {
						const closing = hit.id === "send";
						activate(hit.id);
						return { handled: true, focus: !closing, render: true };
					}
					if (confirmId) {
						clearConfirm();
						refresh();
					}
					if (isCommentEditorHit(event.y, editorTop, editorHeight)) {
						activate("comment");
						editor.handleMouse({ ...event, x: event.x - 1, y: event.y - editorTop, width: Math.max(1, viewWidth - 2), height: editorHeight });
						return { handled: true, focus: true, render: true };
					}
					setCommenting(false);
					if (event.y === 1) {
						selected = -1;
						commentTarget = 0;
					}
					const bodyTop = 2;
					const visibleCount = Math.min(bodyRows, Math.max(0, rows.length - scroll));
					const visibleIndex = event.y - bodyTop;
					if (visibleIndex >= 0 && visibleIndex < visibleCount) {
						const row = rows[scroll + visibleIndex];
						if (row) {
							selected = row.source;
							refresh();
						}
					}
					refresh();
					return { handled: true, focus: true };
				}
				return { handled: true };
			}

			function render(width: number): string[] {
				viewWidth = width;
				if (cached && cachedWidth === width && rows.length > 0) return cached;
				cachedWidth = width;
				const inner = Math.max(1, width - 2);
				const editorLines = editor.render(inner);
				editorHeight = editorLines.length;
				rows = layout(sources, comments, theme, inner);
				bodyRows = bodyHeight();
				const maxScroll = Math.max(0, rows.length - bodyRows);
				scroll = Math.max(0, Math.min(scroll, maxScroll));
				const slice = rows.slice(scroll, scroll + bodyRows);
				const lines: string[] = [];
				const rule = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
				const line = sources[selected];
				const title = `${theme.bold(theme.fg("warning", "Plan"))}  ${theme.fg("dim", line ? `L${line.number} · title: document comment` : "Document comment")}`;
				lines.push(rule);
				lines.push(pad(` ${title}`, width));
				for (const row of slice) {
					const painted = pad(row.text, width);
					lines.push(paintPlanRow(theme, painted, row.source === selected));
				}
				while (lines.length < bodyRows + 2) lines.push(pad("", width));
				const bar = paintActionBar(currentActions(), theme, hoverId, width, lines.length, prefixText());
				buttonHits = bar.hits;
				for (const barLine of bar.lines) lines.push(pad(barLine, width));
				editorTop = lines.length;
				const target = commenting || editor.getText() ? commentTarget : sources[selected]?.number ?? 0;
				const scope = target ? `L${target}` : "Document";
				editorLines[0] = theme.fg(commenting ? "accent" : "dim", `${scope} · ${commenting ? "Editing · Tab to browse" : "Click or Tab to comment"}`);
				for (const editorLine of editorLines) {
					lines.push(pad(` ${editorLine}`, width));
				}
				lines.push(rule);
				cached = lines;
				return lines;
			}

			activateImeWindow("browse");
			return {
				render,
				invalidate: () => {
					cached = undefined;
					editor.invalidate();
				},
				handleInput,
				handleMouse,
				get focused() {
					return focused;
				},
				set focused(value: boolean) {
					focused = value;
					syncEditorFocus();
					cached = undefined;
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

function layout(sources: PlanSourceLine[], comments: Map<number, string[]>, theme: Theme, width: number): VisualRow[] {
	const gutter = 8;
	const textWidth = Math.max(1, width - gutter);
	const rows: VisualRow[] = [];
	for (const comment of comments.get(0) ?? []) {
		for (const text of wrapTextWithAnsi(theme.fg("warning", formatDocumentComment(comment)), width)) {
			rows.push({ source: -1, text });
		}
	}
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index]!;
		const mark = comments.has(source.number) ? theme.fg("warning", "✎") : " ";
		const number = theme.fg("dim", String(source.number).padStart(4, " "));
		const body = styleLine(source, theme);
		const wrapped = wrapTextWithAnsi(body, textWidth);
		const first = wrapped[0] ?? "";
		rows.push({ source: index, text: `${number} ${mark} ${first}` });
		for (const extra of wrapped.slice(1)) rows.push({ source: index, text: `${" ".repeat(gutter)}${extra}` });
		for (const comment of comments.get(source.number) ?? []) {
			const preview = wrapTextWithAnsi(theme.fg("warning", formatLineComment(source.number, comment)), textWidth);
			for (const line of preview.slice(0, 2)) rows.push({ source: index, text: `${" ".repeat(gutter)}${line}` });
		}
	}
	return rows;
}

/**
 * 计划 markdown 的上色。只用当前 theme 的语义槽，不写死色值。
 *
 * 标题按层级用不同职责的色，避免都落在 `text` / `mdHeading` 上
 *（grok-build 里这两个槽是同一个白）：
 *   h1 warning        要拍板的标题，注意色
 *   h2 mdLink         章节，链接/导航色
 *   h3 syntaxType     分类，类型色
 *   h4 success        具体改动，成功/增加色
 *   h5 syntaxString   细节，字面量色
 *   h6 syntaxComment  次要标题，注释色
 *
 * 其余按槽的本职：列表点 `mdListBullet`，序号 `syntaxNumber`，
 * 引用 `mdQuote`，分割线 `mdHr`，代码块 `mdCodeBlock` / `mdCodeBlockBorder`，
 * 行内代码用 `syntaxString`（字面量；`mdCode` 在当前皮肤里和正文同色），
 * 链接文字 `mdLink`、地址 `mdLinkUrl`，强调 `accent`，斜体 `thinkingText`。
 * 任务：已勾 `success`，未勾 `warning`。
 */
type Slot = Parameters<Theme["fg"]>[0];

const HEADING_SLOT: Record<1 | 2 | 3 | 4 | 5 | 6, Slot> = {
	1: "warning",
	2: "mdLink",
	3: "syntaxType",
	4: "success",
	5: "syntaxString",
	6: "syntaxComment",
};

const TASK = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s*)(.*)$/;
const BULLET = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])(\s+)(.*)$/;
const QUOTE = /^(\s*)(>+)(\s?)(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE = /^(\s*)(`{3,})(.*)$/;

function styleLine(source: PlanSourceLine, theme: Theme): string {
	const fence = FENCE.exec(source.text);
	if (fence) {
		const [, indent, ticks, rest] = fence;
		return theme.fg("dim", indent!) + theme.fg("mdCodeBlockBorder", ticks!) + (rest ? theme.fg("syntaxKeyword", rest) : "");
	}
	if (source.fence) return theme.fg("mdCodeBlock", source.text);
	if (source.heading > 0) {
		const slot = HEADING_SLOT[source.heading as 1 | 2 | 3 | 4 | 5 | 6] ?? "mdHeading";
		const label = headingText(source.text) || source.text;
		return theme.bold(theme.fg(slot, label));
	}
	if (HR.test(source.text) || TABLE_RULE.test(source.text)) return theme.fg("mdHr", source.text);

	const task = TASK.exec(source.text);
	if (task) {
		const [, indent, marker, gap, box, after, rest] = task;
		const done = box!.toLowerCase().includes("x");
		const markSlot: Slot = done ? "success" : "warning";
		return (
			theme.fg("dim", indent!) +
			theme.fg("mdListBullet", marker!) +
			gap! +
			theme.fg(markSlot, box!) +
			after! +
			styleInline(rest!, theme, done ? "muted" : "text")
		);
	}
	const bullet = BULLET.exec(source.text);
	if (bullet) {
		const [, indent, marker, gap, rest] = bullet;
		return theme.fg("dim", indent!) + theme.fg("mdListBullet", marker!) + gap! + styleInline(rest!, theme);
	}
	const ordered = ORDERED.exec(source.text);
	if (ordered) {
		const [, indent, marker, gap, rest] = ordered;
		return theme.fg("dim", indent!) + theme.fg("syntaxNumber", marker!) + gap! + styleInline(rest!, theme);
	}
	const quote = QUOTE.exec(source.text);
	if (quote) {
		const [, indent, marks, gap, rest] = quote;
		return theme.fg("dim", indent!) + theme.fg("syntaxComment", marks!) + gap! + styleInline(rest!, theme, "mdQuote");
	}
	if (source.text.includes("|") && source.text.split("|").length >= 3) return styleTable(source.text, theme);
	return styleInline(source.text, theme);
}

const INLINE =
	/(\*\*[^*\n]+?\*\*|~~[^~\n]+?~~|(?<!\*)\*[^*\n]+?\*(?!\*)|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s)]+)/g;

function styleInline(text: string, theme: Theme, body: Slot = "text"): string {
	const parts = text.split(INLINE);
	return parts
		.map((part) => {
			if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
				return theme.bold(theme.fg("accent", part.slice(2, -2)));
			}
			if (part.startsWith("~~") && part.endsWith("~~") && part.length >= 4) {
				return theme.strikethrough(theme.fg("dim", part.slice(2, -2)));
			}
			if (part.startsWith("*") && part.endsWith("*") && part.length >= 3) {
				return theme.italic(theme.fg("thinkingText", part.slice(1, -1)));
			}
			if (part.startsWith("`") && part.endsWith("`") && part.length >= 3) {
				return theme.fg("syntaxString", part.slice(1, -1));
			}
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
			if (link) {
				return (
					theme.fg("syntaxPunctuation", "[") +
					theme.fg("mdLink", link[1]!) +
					theme.fg("syntaxPunctuation", "](") +
					theme.fg("mdLinkUrl", link[2]!) +
					theme.fg("syntaxPunctuation", ")")
				);
			}
			if (part.startsWith("http://") || part.startsWith("https://")) return theme.underline(theme.fg("mdLink", part));
			return part ? theme.fg(body, part) : part;
		})
		.join("");
}

function styleTable(text: string, theme: Theme): string {
	const cells = text.split("|");
	return cells
		.map((cell, index) => {
			const painted = styleInline(cell, theme);
			return index === cells.length - 1 ? painted : painted + theme.fg("syntaxPunctuation", "|");
		})
		.join("");
}

function pad(text: string, width: number): string {
	return truncateToWidth(text, width, "", true);
}

/** 按钮文字。悬停把左侧空格换成 `>`，宽度不变，点击区域不会跳。 */
export function buttonFace(key: string, label: string, hovered: boolean): string {
	return `[${hovered ? ">" : " "}${key} ${label} ]`;
}

const CONFIRM_MS = 1200;

function isConfirmAction(id: ReviewActionId): id is ConfirmActionId {
	return id === "approve" || id === "doc" || id === "reject";
}

export function commentTargetForSelection(selected: number, sources: readonly PlanSourceLine[]): number {
	return sources[selected]?.number ?? 0;
}

export function isCommentEditorHit(y: number, top: number, height: number): boolean {
	return y >= top && y < top + height;
}


export function paintPlanRow(theme: Theme, text: string, selected: boolean): string {
	if (!selected) return text;
	return theme.style(text, {
		bg: mixColors(theme.colors.selectedBg, theme.colors.mdLink, 0.22, "srgb"),
		bold: true,
	});
}

function pendingLabel(label: string): string {
	return "confirm".padEnd(label.length, " ");
}

export function reviewActions(commenting: boolean, canSend: boolean, pending?: ConfirmActionId): ReviewAction[] {
	if (commenting) {
		return [
			{ id: "save", key: "enter", label: "save", enabled: true, tone: "success" },
			{ id: "cancel", key: "esc", label: "cancel", enabled: true, tone: "warning" },
		];
	}
	const action = (id: ConfirmActionId, key: string, label: string, tone: Slot): ReviewAction => ({
		id,
		key,
		label: pending === id ? pendingLabel(label) : label,
		enabled: true,
		tone: pending === id ? "warning" : tone,
		pending: pending === id,
	});
	return [
		{ id: "comment", key: "c", label: "comment", enabled: true, tone: "text" },
		{ id: "send", key: "s", label: "send", enabled: canSend, tone: "accent" },
		action("approve", "a", "approve", "success"),
		action("doc", "w", "doc only", "text"),
		action("reject", "esc", "reject", "error"),
	];
}

/** 按可见宽度折行。`x` 是按钮左缘，和渲染时的单元格一致。 */
export function planActionRows(
	actions: Pick<ReviewAction, "id" | "key" | "label">[],
	width: number,
	prefixWidth: number,
): { id: ReviewActionId; x: number; width: number }[][] {
	const gap = 2;
	const rows: { id: ReviewActionId; x: number; width: number }[][] = [[]];
	let x = Math.max(0, prefixWidth);
	for (const action of actions) {
		const buttonWidth = visibleWidth(buttonFace(action.key, action.label, false));
		const row = rows[rows.length - 1]!;
		if (row.length > 0 && x + buttonWidth > width) {
			rows.push([]);
			x = 1;
		}
		rows[rows.length - 1]!.push({ id: action.id, x, width: buttonWidth });
		x += buttonWidth + gap;
	}
	return rows;
}

function paintActionBar(
	actions: ReviewAction[],
	theme: Theme,
	hoverId: ReviewActionId | undefined,
	width: number,
	originY: number,
	prefix: string,
): { lines: string[]; hits: ButtonHit[] } {
	const placed = planActionRows(actions, width, visibleWidth(prefix));
	const byId = new Map(actions.map((action) => [action.id, action]));
	const lines: string[] = [];
	const hits: ButtonHit[] = [];
	placed.forEach((row, rowIndex) => {
		const parts: string[] = [];
		let cursor = 0;
		if (rowIndex === 0 && prefix) {
			parts.push(theme.fg("dim", prefix));
			cursor = visibleWidth(prefix);
		}
		for (const spot of row) {
			if (spot.x > cursor) parts.push(" ".repeat(spot.x - cursor));
			const action = byId.get(spot.id)!;
			const hovered = hoverId === action.id;
			parts.push(paintActionButton(action, theme, hovered));
			hits.push({ id: action.id, y: originY + rowIndex, x: spot.x, width: spot.width, enabled: action.enabled });
			cursor = spot.x + spot.width;
		}
		lines.push(parts.join(""));
	});
	return { lines, hits };
}

function paintActionButton(action: ReviewAction, theme: Theme, hovered: boolean): string {
	const face = buttonFace(action.key, action.label, hovered && action.enabled);
	if (!action.enabled) return theme.style(face, hovered ? { fg: "muted", underline: true } : { fg: "dim" });
	if (action.pending || hovered) return theme.style(face, { fg: action.pending ? "warning" : "accent", bg: "selectedBg", bold: true, underline: true });
	return theme.style(face, { fg: action.tone, bg: "customMessageBg" });
}
