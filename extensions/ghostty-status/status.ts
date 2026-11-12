/** Ghostty tab status sequences. Pure so it can be tested without a TTY. */

export type StatusPhase = "idle" | "working" | "blocked" | "done" | "error";
export type BlockedKind = "permission" | "question";

export interface StatusReport {
	phase: StatusPhase;
	/** Short human text. Already sanitized by the caller is fine; this module sanitizes again. */
	detail: string;
	folder: string;
	kind?: BlockedKind;
}

const WAITING_TOOLS = new Set([
	"ask_user_question",
	"exit_plan_mode",
	"enter_plan_mode",
]);

const STATUS_EMOJI: Record<StatusPhase, string> = {
	idle: "",
	working: "⚡",
	blocked: "✋",
	done: "✅",
	error: "❌",
};

/** Tab badge. Question waits are distinct from permission waits. */
export function statusEmoji(report: StatusReport): string {
	if (report.phase === "blocked" && report.kind === "question") return "❓";
	return STATUS_EMOJI[report.phase];
}

export function tabTitle(report: StatusReport): string {
	const mark = statusEmoji(report);
	const parts = ["pi", sanitize(report.folder, 24)];
	const detail = sanitize(report.detail, 48);
	if (detail && detail !== mark) parts.push(detail);
	const body = parts.filter(Boolean).join(" · ");
	return mark ? `${mark} ${body}` : body;
}

export function activityFromTool(toolName: string, args: unknown): { detail: string; blocked: boolean; kind?: BlockedKind } {
	const detail = sanitize(detailFromArgs(toolName, args), 48) || toolName;
	if (WAITING_TOOLS.has(toolName)) {
		return { detail, blocked: true, kind: toolName === "ask_user_question" ? "question" : "permission" };
	}
	return { detail, blocked: false };
}

/** OSC bytes for one report. Ghostty 1.3.1 reads the title and OSC 9;4; newer builds also read OSC 7501. */
export function statusSequences(report: StatusReport): string {
	const title = tabTitle(report);
	const msg = sanitize(report.detail, 180) || statusEmoji(report) || "idle";
	return [
		osc(0, title),
		report.phase === "idle" ? osc(9, "3;") : osc(9, `3;${title}`),
		progressSequence(report.phase),
		programStatus(report, msg),
	].join("");
}

export function clearSequences(): string {
	return [osc(9, "4;0"), osc(9, "3;"), osc(7501, "state=clear:app=pi"), osc(0, "")].join("");
}

/** Ghostty drops OSC 9;4 unless it is repeated during long work. */
export function progressKeepalive(phase: StatusPhase): string {
	return phase === "idle" ? "" : progressSequence(phase);
}

function progressSequence(phase: StatusPhase): string {
	switch (phase) {
		case "working":
			return osc(9, "4;3");
		case "blocked":
			return osc(9, "4;4");
		case "done":
			return osc(9, "4;1;100");
		case "error":
			return osc(9, "4;2");
		default:
			return osc(9, "4;0");
	}
}

function programStatus(report: StatusReport, msg: string): string {
	const pairs = [`state=${report.phase === "idle" ? "idle" : report.phase}`, "app=pi", `msg=${Buffer.from(msg, "utf8").toString("base64")}`];
	if (report.phase === "blocked" && report.kind) pairs.push(`kind=${report.kind}`);
	return osc(7501, pairs.join(":"));
}

function osc(code: number, body: string): string {
	return `\x1b]${code};${body}\x07`;
}

function detailFromArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") return record.command.split("\n")[0] ?? toolName;
	if (typeof record.path === "string") return record.path.split("/").pop() || record.path;
	if (typeof record.file_path === "string") return record.file_path.split("/").pop() || record.file_path;
	if (typeof record.question === "string") return record.question;
	if (Array.isArray(record.questions)) {
		const first = record.questions[0];
		if (first && typeof first === "object" && typeof (first as { question?: unknown }).question === "string") {
			return (first as { question: string }).question;
		}
	}
	if (typeof record.plan === "string") return record.plan.split("\n").find((line) => line.trim()) ?? toolName;
	return toolName;
}

export function sanitize(value: string, max: number): string {
	const flat = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export function assistantSummary(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content);
		if (text) return sanitize(text, 48);
	}
	return "";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
		.filter(Boolean)
		.join(" ");
}
