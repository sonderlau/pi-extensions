export const KINDS = [
	"none",
	"bar",
	"grouped",
	"stacked",
	"line",
	"slope",
	"share",
	"heatmap",
	"histogram",
	"scatter",
	"stat",
	"progress",
	"diverging",
] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
	return (KINDS as readonly string[]).includes(value);
}

export function parseKind(text: string): Kind {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return "none";
	try {
		const parsed = JSON.parse(match[0]) as { kind?: unknown };
		if (typeof parsed.kind === "string" && isKind(parsed.kind)) return parsed.kind;
	} catch {
		return "none";
	}
	return "none";
}
