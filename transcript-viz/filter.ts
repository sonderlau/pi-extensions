import type { Kind } from "./kinds.ts";
import { colValues, labelColumn, numericColumns, parseNum, type Table } from "./parse.ts";

/** Cheap necessity gate. Prefer skipping; the judge still has to say yes. */
export function worthCharting(table: Table): boolean {
	if (table.rows.length === 0) return false;
	if (table.rows.length > 40 || table.headers.length > 12) return false;
	const cols = numericColumns(table);
	if (cols.length === 0) return false;

	const cells = table.rows.flat();
	const long = cells.filter((c) => c.length > 48).length;
	if (cells.length > 0 && long > cells.length * 0.3) return false;

	if (looksLikeIdIndex(table, cols)) return false;

	const n = table.rows.length;
	if (n === 1) return cols.length >= 2 || looksProgress(table, cols);

	return hasSpread(table, cols);
}

export function heuristicKind(table: Table): Kind {
	if (!worthCharting(table)) return "none";
	const cols = numericColumns(table);
	const n = table.rows.length;
	const label = labelColumn(table);
	const vals = cols.flatMap((c) => colValues(table, c));
	const hasNeg = vals.some((v) => v < 0);

	if (n === 1) {
		if (looksProgress(table, cols)) return "progress";
		if (cols.length <= 4) return "stat";
		return "none";
	}
	if (hasNeg) return "diverging";
	if (looksHeatmap(table, cols)) return "heatmap";
	if (cols.length === 2 && n <= 8 && looksBeforeAfter(table, cols)) return "slope";
	if (cols.length === 1 && looksShare(table, cols[0]!)) return "share";
	if (cols.length === 1 && n === 1) return "progress";
	if (n >= 8 && cols.length === 1 && label == null) return "histogram";
	if (cols.length === 2 && n >= 5 && label == null) return "scatter";
	if (cols.length >= 2 && n <= 10 && looksComposition(table, cols)) return "stacked";
	if (cols.length === 1 && n >= 2 && looksOrdered(table, label)) return "line";
	if (cols.length >= 2 && n <= 12) return "grouped";
	if (cols.length === 1 && n <= 16) return "bar";
	if (cols.length === 1 && n > 16) return "histogram";
	return "none";
}

function hasSpread(table: Table, cols: number[]): boolean {
	for (const c of cols) {
		const vals = colValues(table, c);
		if (vals.length < 2) continue;
		if (Math.max(...vals) !== Math.min(...vals)) return true;
	}
	return false;
}

function looksLikeIdIndex(table: Table, cols: number[]): boolean {
	if (cols.length !== 1 || table.headers.length > 3) return false;
	const vals = colValues(table, cols[0]!);
	if (vals.length < 3) return false;
	return vals.every((v, i) => v === vals[0]! + i);
}

function looksProgress(table: Table, cols: number[]): boolean {
	const heads = table.headers.join(" ");
	if (!/done|total|progress|percent|complete|max|goal/i.test(heads) && !table.rows.some((r) =>
		cols.some((c) => (r[c] ?? "").includes("%")),
	)) {
		return false;
	}
	if (table.rows.length === 0 || cols.length === 0) return false;
	const raw = table.rows[0]![cols[0]!] ?? "";
	const v = parseNum(raw);
	if (v == null) return false;
	if (raw.includes("%") && v >= 0 && v <= 100) return true;
	if (cols.length >= 2) {
		const max = parseNum(table.rows[0]![cols[1]!] ?? "");
		return max != null && max > 0 && v >= 0 && v <= max;
	}
	return v >= 0 && v <= 1;
}

function looksHeatmap(table: Table, cols: number[]): boolean {
	if (cols.length < 3 || table.rows.length < 3) return false;
	return cols.length === table.headers.length || cols.length === table.headers.length - 1;
}

function looksBeforeAfter(table: Table, cols: number[]): boolean {
	const names = cols.map((c) => table.headers[c] ?? "").join(" ");
	return /before|after|old|new|from|to|start|end|was|now/i.test(names);
}

function looksShare(table: Table, col: number): boolean {
	const vals = colValues(table, col);
	if (vals.length < 2) return false;
	const sum = vals.reduce((a, b) => a + b, 0);
	const pct = table.rows.some((r) => (r[col] ?? "").includes("%"));
	if (pct && Math.abs(sum - 100) <= 5) return true;
	return pct && vals.every((v) => v >= 0 && v <= 100) && Math.abs(sum - 100) <= 8;
}

function looksComposition(table: Table, cols: number[]): boolean {
	if (cols.length < 2) return false;
	return table.rows.every((row) =>
		cols.every((c) => {
			const n = parseNum(row[c] ?? "");
			return n == null || n >= 0;
		}),
	);
}

function looksOrdered(table: Table, label: number | null): boolean {
	if (label == null) return table.rows.length >= 4;
	const samples = table.rows.slice(0, 4).map((r) => r[label] ?? "");
	return samples.some((s) =>
		/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|week|day|mon/i.test(s),
	);
}
