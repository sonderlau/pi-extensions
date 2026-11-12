/**
 * Report pi's run state to Ghostty.
 *
 * Ghostty 1.3.1 shows OSC 0 / OSC 9;3 in the tab title and OSC 9;4 as the
 * progress mark under the tab bar. OSC 7501 is the program-status protocol
 * for terminals that understand it; 1.3.1 ignores it.
 *
 * Leave terminal.showTerminalProgress off. Its keepalive rewrites OSC 9;4;3
 * and would cover the paused "waiting for you" state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activityFromTool,
	assistantSummary,
	clearSequences,
	progressKeepalive,
	statusSequences,
	tabTitle,
	type BlockedKind,
	type StatusPhase,
	type StatusReport,
} from "./status.ts";

const KEEPALIVE_MS = 1000;

interface Block {
	detail: string;
	kind: BlockedKind;
}

export default function ghosttyStatus(pi: ExtensionAPI) {
	let running = false;
	let compacting = false;
	let promptDepth = 0;
	let promptDetail = "";
	let promptKind: BlockedKind = "question";
	let outcome: "completed" | "aborted" | "error" = "completed";
	let summary = "";
	let activity = "";
	let folder = "pi";
	const blocking = new Map<string, Block>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastWritten = "";
	let ctx: ExtensionContext | undefined;

	const report = (): StatusReport => {
		const block = promptDepth > 0
			? { detail: promptDetail, kind: promptKind }
			: blocking.size > 0
				? [...blocking.values()].at(-1)
				: undefined;
		if (block) return { phase: "blocked", detail: block.detail, folder, kind: block.kind };
		if (running || compacting) return { phase: "working", detail: activity || (compacting ? "📦" : "💭"), folder };
		if (outcome === "error") return { phase: "error", detail: summary || "❌", folder };
		if (outcome === "completed" && summary) return { phase: "done", detail: summary, folder };
		return { phase: "idle", detail: "", folder };
	};

	const write = (force = false) => {
		if (!process.stdout.isTTY) return;
		const next = report();
		const bytes = statusSequences(next);
		if (!force && bytes === lastWritten) return;
		lastWritten = bytes;
		process.stdout.write(bytes);
		ctx?.ui.setTitle(tabTitle(next));
		const phase: StatusPhase = next.phase;
		if (phase === "idle") stopKeepalive();
		else startKeepalive();
	};

	const startKeepalive = () => {
		if (timer) return;
		timer = setInterval(() => {
			const bytes = progressKeepalive(report().phase);
			if (!process.stdout.isTTY || !bytes) return;
			process.stdout.write(bytes);
		}, KEEPALIVE_MS);
		timer.unref?.();
	};

	const stopKeepalive = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	const bind = (next: ExtensionContext) => {
		ctx = next;
		folder = next.cwd.split("/").filter(Boolean).pop() || "pi";
	};

	pi.on("session_start", async (_event, next) => {
		bind(next);
		running = false;
		compacting = false;
		promptDepth = 0;
		blocking.clear();
		outcome = "completed";
		summary = "";
		activity = "";
		write(true);
	});

	pi.on("session_shutdown", async () => {
		stopKeepalive();
		if (process.stdout.isTTY) process.stdout.write(clearSequences());
		lastWritten = "";
	});

	pi.on("session_before_compact", async (_event, next) => {
		bind(next);
		compacting = true;
		activity = "📦";
		write();
	});

	pi.on("session_compact", async () => {
		compacting = false;
		write();
	});

	pi.on("session_compact_failed", async () => {
		compacting = false;
		outcome = "error";
		summary = "📦";
		write();
	});

	pi.on("agent_start", async (_event, next) => {
		bind(next);
		running = true;
		outcome = "completed";
		summary = "";
		activity = "💭";
		write();
	});

	pi.on("turn_start", async (_event, next) => {
		bind(next);
		running = true;
		outcome = "completed";
		if (!activity) activity = "💭";
		write();
	});

	pi.on("tool_execution_start", async (event, next) => {
		bind(next);
		const activityReport = activityFromTool(event.toolName, event.args);
		activity = activityReport.detail;
		if (activityReport.blocked && activityReport.kind) {
			blocking.set(event.toolCallId, { detail: activityReport.detail, kind: activityReport.kind });
		}
		write();
	});

	pi.on("tool_execution_end", async (event, next) => {
		bind(next);
		blocking.delete(event.toolCallId);
		if (event.isError) activity = `❌ ${event.toolName}`;
		write();
	});

	pi.on("ui_prompt_start", async (event, next) => {
		bind(next);
		promptDepth++;
		promptDetail = event.title || (event.kind === "confirm" ? "✋" : "❓");
		promptKind = event.kind === "confirm" ? "permission" : "question";
		write();
	});

	pi.on("ui_prompt_end", async (_event, next) => {
		bind(next);
		promptDepth = Math.max(0, promptDepth - 1);
		write();
	});

	pi.on("agent_end", async (event) => {
		const text = assistantSummary(event.messages);
		if (text) summary = text;
	});

	pi.on("agent_before_settle", async (event, next) => {
		bind(next);
		outcome = event.outcome;
		write();
	});

	pi.on("agent_settled", async (_event, next) => {
		bind(next);
		running = false;
		blocking.clear();
		write();
	});
}
