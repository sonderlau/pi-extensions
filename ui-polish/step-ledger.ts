/**
 * 每条工具结果末尾附上「到这一步为止」的步数和一行结论。
 *
 * 不落盘、不插 user 消息：落盘会把滚动摘要写进会话；custom 会被 convertToLlm
 * 变成 user，打断 assistant → tool → assistant。
 *
 * 每条结果都带一份快照，而不是只改最后一条：下一步从 session 取出的是干净结果，
 * 只改最后一条会让前缀缓存在上一条大结果处断开。快照是到该条为止的纯函数，旧后缀字节不变。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "[steps as of ";
const RECENT = 8;
const ARG_LIMIT = 80;
const STATUS_LINE =
	/Command exited with code \d+|Command aborted|terminated without an exit code/;

export interface StepSummary {
	toolName: string;
	hint: string;
	outcome: string;
	failed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function clip(value: string, limit = ARG_LIMIT): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function argsOf(args: unknown): Record<string, unknown> | undefined {
	return isRecord(args) && !Array.isArray(args) ? args : undefined;
}

/** 参数不在 tool result 上，由调用方用 toolCallId 对上 assistant 的 arguments。 */
function argHint(toolName: string, args: unknown): string {
	const obj = argsOf(args);
	const pick = (value: string | undefined): string | undefined => {
		if (value === undefined) return undefined;
		const line = toolName === "bash" ? value.split(/\r?\n/, 1)[0] : value;
		const clipped = clip(line ?? "");
		return clipped || undefined;
	};

	if (toolName === "bash") {
		const command = pick(stringArg(obj, "command"));
		if (command) return command;
	}
	if (toolName === "grep" || toolName === "find") {
		const pattern = stringArg(obj, "pattern");
		const path = stringArg(obj, "path");
		if (pattern || path) {
			const hint = clip([pattern, path].filter(Boolean).join(" — "));
			if (hint) return hint;
		}
	}
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		const path = pick(stringArg(obj, "path"));
		if (path) return path;
	}
	for (const key of ["path", "command", "pattern", "query", "url"]) {
		const hint = pick(stringArg(obj, key));
		if (hint) return hint;
	}
	if (obj) {
		for (const value of Object.values(obj)) {
			const hint = pick(typeof value === "string" ? value : undefined);
			if (hint) return hint;
		}
	}
	return "-";
}

function errorLine(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const status = [...lines].reverse().find((line) => STATUS_LINE.test(line));
	if (status) return `error: ${clip(status)}`;
	// 大 JSON 的第一行是 `{`，那不是结论。
	if (text.trim().startsWith("{")) return "error";
	const first = lines.find((line) => line !== "}");
	return first ? `error: ${clip(first)}` : "error";
}

export function summarizeStep(
	result: { toolName?: unknown; content?: unknown; details?: unknown; isError?: unknown },
	args: unknown,
): StepSummary {
	const toolName = typeof result.toolName === "string" && result.toolName ? result.toolName : "tool";
	const text = textOf(result.content);
	const details = isRecord(result.details) ? result.details : undefined;
	const limit = details?.matchLimitReached;
	let outcome = "ok";
	if (result.isError === true) outcome = errorLine(text);
	else if (text.trim() === "No matches found") outcome = "0 hits";
	else if (typeof limit === "number") outcome = `≥${limit} hits`;
	return { toolName, hint: argHint(toolName, args), outcome, failed: result.isError === true };
}

export function buildLedger(steps: readonly StepSummary[], compacted: boolean): string {
	const n = steps.length;
	const failed = steps.filter((step) => step.failed).length;
	const calls = n === 1 ? "1 tool call" : `${n} tool calls`;
	let header = `${MARKER}${n}] ${calls} since the last user message, ${failed} failed.`;
	if (compacted) header += " Earlier steps were compacted.";
	const recent = steps.slice(-RECENT);
	const lines = recent.map((step, i) => {
		const number = n - recent.length + i + 1;
		return `${number} ${step.toolName} ${step.hint} — ${step.outcome}`;
	});
	const last = steps.at(-1);
	const prev = steps.at(-2);
	if (last && prev && last.toolName === prev.toolName && last.hint === prev.hint) {
		lines.push(`Repeated ${last.toolName} ${last.hint}. Change approach instead of retrying.`);
	}
	return [header, ...lines].join("\n");
}

function alreadyMarked(message: Record<string, unknown>): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			return part.text.startsWith(MARKER);
		}
	}
	return false;
}

function toolCalls(message: Record<string, unknown>, into: Map<string, unknown>): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
		into.set(part.id, part.arguments);
	}
}

/** 不修改入参。没有本回合工具结果、或末尾已经是账本时，返回同一个数组。 */
export function withLedger<T>(messages: readonly T[]): readonly T[] {
	let lastUser = -1;
	let compacted = false;
	const calls = new Map<string, unknown>();
	messages.forEach((message, index) => {
		if (!isRecord(message)) return;
		if (message.role === "user") lastUser = index;
		if (message.role === "compactionSummary") compacted = true;
		toolCalls(message, calls);
	});

	const steps: { index: number; summary: StepSummary }[] = [];
	messages.forEach((message, index) => {
		if (index <= lastUser || !isRecord(message) || message.role !== "toolResult") return;
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		steps.push({ index, summary: summarizeStep(message, calls.get(id)) });
	});
	if (steps.length === 0) return messages;

	let changed = false;
	const next = messages.map((message, index) => {
		const stepIndex = steps.findIndex((step) => step.index === index);
		if (stepIndex < 0 || !isRecord(message) || alreadyMarked(message)) return message;
		changed = true;
		const ledger = buildLedger(
			steps.slice(0, stepIndex + 1).map((step) => step.summary),
			compacted,
		);
		const content = Array.isArray(message.content) ? message.content : [];
		return { ...message, content: [...content, { type: "text", text: ledger }] };
	});
	return changed ? next : messages;
}

export default function stepLedger(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const next = withLedger(event.messages);
		if (next === event.messages) return;
		return { messages: next };
	});
}
