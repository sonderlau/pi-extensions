import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKind, type Kind } from "./kinds.ts";
import { formatTable, type Table } from "./parse.ts";

const SYSTEM = `You decide if a markdown table should get a small terminal chart under it.

Reply with JSON only: {"kind":"<one>"}
kind is one of: none, bar, grouped, stacked, line, slope, share, heatmap, histogram, scatter, stat, progress, diverging

Default to none. Only pick a chart when it makes comparison obviously easier than reading the table.
Do not chart: IDs, file lists, configs, 1-2 similar numbers, mostly text, sequential indexes, one-off stats that are already clear.

bar: one series, a few categories
grouped: 2-4 series, a few categories
stacked: series that add up per row
line: ordered x (time/step)
slope: two numeric columns that are before/after
share: parts of a whole
heatmap: numeric matrix
histogram: many values, one series
scatter: two measures, no category story
stat: 1-3 headline numbers
progress: current vs max or a percent
diverging: negatives and positives`;

export async function judgeKind(ctx: ExtensionContext, table: Table): Promise<Kind> {
	const model = ctx.model;
	if (!model) return "none";
	const result = await ctx.modelRegistry.complete(model, {
		systemPrompt: SYSTEM,
		messages: [
			{
				role: "user",
				content: formatTable(table),
				timestamp: Date.now(),
			},
		],
	});
	if (result.stopReason === "error") return "none";
	return parseKind(textOf(result.content));
}


function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text ?? "")
		.join("\n");
}
