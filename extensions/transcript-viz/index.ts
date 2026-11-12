import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { draw } from "./draw.ts";
import { heuristicKind, worthCharting } from "./filter.ts";
import { judgeKind } from "./judge.ts";
import type { Kind } from "./kinds.ts";
import { parseTables, type Table } from "./parse.ts";
import { SAMPLES } from "./samples.ts";
import { loadSettings, saveSettings } from "./settings.ts";

const CUSTOM_TYPE = "transcript-viz";
const MAX_PER_MESSAGE = 3;

type VizData = {
	kind: Kind;
	table: Table;
	sourceId: string;
};

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<VizData>(CUSTOM_TYPE, (entry, _opts, theme) => {
		const data = entry.data;
		if (!data?.table || !data.kind || data.kind === "none") return undefined;
		const width = Math.max(36, Math.min(80, (process.stdout.columns ?? 80) - 6));
		const lines = draw(data.kind, data.table, {
			width,
			palette: { fg: (token, text) => theme.fg(token, text) },
		});
		if (lines.length === 0) return undefined;
		const root = new Container();
		root.addChild(new Text(theme.fg("dim", `viz  ${data.kind}`), 1, 0));
		root.addChild(new Text(lines.join("\n"), 1, 0));
		return root;
	});

	pi.registerCommand("viz", {
		description: "Charts under tables",
		getArgumentCompletions: (prefix) => vizCompletions(prefix),
		handler: async (args, ctx) => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const cfg = loadSettings();
			if (tokens[0] === "on" || tokens[0] === "off") {
				cfg.enabled = tokens[0] === "on";
				saveSettings(cfg);
				ctx.ui.notify(`viz ${cfg.enabled ? "on" : "off"}`);
				return;
			}
			if (tokens[0] === "judge" && (tokens[1] === "on" || tokens[1] === "off")) {
				cfg.judge = tokens[1] === "on";
				saveSettings(cfg);
				ctx.ui.notify(`viz judge ${cfg.judge ? "on" : "off"}`);
				return;
			}
			if (tokens[0] === "preview") {
				if (!ctx.hasUI) return;
				for (const sample of SAMPLES) {
					if (sample.kind === "none") continue;
					pi.appendEntry<VizData>(CUSTOM_TYPE, {
						kind: sample.kind,
						table: sample.table,
						sourceId: `preview-${sample.kind}`,
					});
				}
				ctx.ui.notify(`viz preview ${SAMPLES.length}`);
				return;
			}
			ctx.ui.notify(
				`viz ${cfg.enabled ? "on" : "off"}, judge ${cfg.judge ? "on" : "off"}  ·  on|off | judge on|off | preview`,
			);
		},
	});

	pi.on("message_end", (event, ctx) => {
		void chartAfter(pi, event.message, ctx).catch(() => {});
	});
}

async function chartAfter(pi: ExtensionAPI, message: AgentMessage, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const cfg = loadSettings();
	if (!cfg.enabled) return;
	const text = assistantPlain(message);
	if (!text) return;
	const seen = seenIds(ctx);
	let added = 0;
	for (const table of parseTables(text)) {
		if (added >= MAX_PER_MESSAGE) break;
		if (!worthCharting(table)) continue;
		const sourceId = sourceKey(table);
		if (seen.has(sourceId)) continue;
		const kind = await pickKind(ctx, table, cfg.judge);
		if (kind === "none") continue;
		seen.add(sourceId);
		added++;
		pi.appendEntry<VizData>(CUSTOM_TYPE, { kind, table, sourceId });
	}
}

async function pickKind(ctx: ExtensionContext, table: Table, judge: boolean): Promise<Kind> {
	if (!judge || !ctx.model) return heuristicKind(table);
	try {
		return await judgeKind(ctx, table);
	} catch {
		return heuristicKind(table);
	}
}

function assistantPlain(message: AgentMessage): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			parts.push(String(block.text));
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function seenIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const id = (entry.data as VizData | undefined)?.sourceId;
		if (id) ids.add(id);
	}
	return ids;
}

function sourceKey(table: Table): string {
	return createHash("sha256").update(JSON.stringify(table)).digest("hex").slice(0, 16);
}


function vizCompletions(prefix: string): { value: string; label: string; description: string }[] | null {
	const raw = prefix.trimStart();
	const parts = raw.split(/\s+/).filter(Boolean);
	const top = [
		{ value: "on", label: "on", description: "enable charts" },
		{ value: "off", label: "off", description: "disable charts" },
		{ value: "judge", label: "judge", description: "on|off — LLM picker" },
		{ value: "preview", label: "preview", description: "append 12 sample charts" },
	];
	if (parts.length === 0) return top;
	if (parts.length === 1 && !prefix.endsWith(" ")) {
		const hit = top.filter((item) => item.value.startsWith(parts[0]!));
		return hit.length > 0 ? hit : null;
	}
	if (parts[0] === "judge") {
		const cur = parts[1] ?? "";
		const items = ["on", "off"]
			.filter((item) => item.startsWith(cur))
			.map((item) => ({
				value: `judge ${item}`,
				label: item,
				description: item === "on" ? "use current model" : "heuristic only",
			}));
		return items.length > 0 ? items : null;
	}
	return null;
}
