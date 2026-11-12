import type { Kind } from "./kinds.ts";
import { colValues, labelColumn, numericColumns, parseNum, type Table } from "./parse.ts";

export type ColorToken = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";
export type Palette = { fg: (token: ColorToken, text: string) => string };

const SERIES: ColorToken[] = ["accent", "success", "warning", "error", "muted"];
const SPARK = "▁▂▃▄▅▆▇█";
const HEAT = "░▒▓█";
const IDENTITY: Palette = { fg: (_t, s) => s };

export function draw(
	kind: Kind,
	table: Table,
	opts?: { width?: number; palette?: Palette },
): string[] {
	if (kind === "none") return [];
	const width = Math.max(24, opts?.width ?? 56);
	const p = opts?.palette ?? IDENTITY;
	const cols = numericColumns(table);
	if (cols.length === 0) return [];
	switch (kind) {
		case "bar":
			return drawBar(table, cols, width, p);
		case "grouped":
			return drawGrouped(table, cols, width, p);
		case "stacked":
			return drawStacked(table, cols, width, p);
		case "line":
			return drawLine(table, cols, width, p);
		case "slope":
			return drawSlope(table, cols, width, p);
		case "share":
			return drawShare(table, cols, width, p);
		case "heatmap":
			return drawHeatmap(table, cols, width, p);
		case "histogram":
			return drawHistogram(table, cols, width, p);
		case "scatter":
			return drawScatter(table, cols, width, p);
		case "stat":
			return drawStat(table, cols, p);
		case "progress":
			return drawProgress(table, cols, width, p);
		case "diverging":
			return drawDiverging(table, cols, width, p);
	}
}

function labels(table: Table): string[] {
	const col = labelColumn(table);
	if (col == null) return table.rows.map((_, i) => String(i + 1));
	return table.rows.map((r, i) => r[col] || String(i + 1));
}

function dw(s: string): number {
	let n = 0;
	for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	return n;
}

function clip(s: string, w: number, align: "left" | "right" = "left"): string {
	const chars = [...s];
	let out = "";
	let used = 0;
	for (const ch of chars) {
		const cw = (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
		if (used + cw > w) break;
		out += ch;
		used += cw;
	}
	const fill = " ".repeat(Math.max(0, w - used));
	return align === "right" ? fill + out : out + fill;
}

function fmt(n: number): string {
	if (Number.isInteger(n) && Math.abs(n) < 10000) return String(n);
	if (Math.abs(n) >= 1000) return n.toFixed(0);
	return String(Number(n.toFixed(2)));
}

function numW(vals: number[]): number {
	return Math.max(3, ...vals.map((v) => dw(fmt(v))));
}

function track(frac: number, width: number, p: Palette, fill: ColorToken): string {
	const n = Math.max(0, Math.min(1, frac)) * width;
	const full = Math.floor(n);
	const half = n - full >= 0.5;
	const filled = Math.min(width, full + (half ? 1 : 0));
	const head = "█".repeat(full) + (half && full < width ? "▌" : "");
	const tail = "░".repeat(Math.max(0, width - filled));
	return p.fg(fill, head) + p.fg("dim", tail);
}

function maxAbs(vals: number[]): number {
	return Math.max(1e-9, ...vals.map((v) => Math.abs(v)));
}

function labelW(names: string[], cap: number): number {
	return Math.min(cap, Math.max(4, ...names.map(dw)));
}

function drawBar(table: Table, cols: number[], width: number, p: Palette): string[] {
	const col = cols[0]!;
	const vals = table.rows.map((r) => parseNum(r[col] ?? "") ?? 0);
	const names = labels(table);
	const lw = labelW(names, 14);
	const nw = numW(vals);
	const bw = Math.max(8, width - lw - nw - 2);
	const peak = Math.max(0, ...vals) || 1;
	return names.map((name, i) => {
		const v = vals[i] ?? 0;
		return `${clip(name, lw)} ${track(v / peak, bw, p, "accent")} ${clip(fmt(v), nw, "right")}`;
	});
}

function drawGrouped(table: Table, cols: number[], width: number, p: Palette): string[] {
	const names = labels(table);
	const use = cols.slice(0, 3);
	const lw = labelW(names, 10);
	const all = use.flatMap((c) => table.rows.map((r) => parseNum(r[c] ?? "") ?? 0));
	const peak = Math.max(1, ...all.map((v) => Math.abs(v)));
	const nw = numW(all);
	const gap = 1;
	const bw = Math.max(4, Math.floor((width - lw - 1 - use.length * (nw + 1 + gap)) / use.length));
	const head =
		clip("", lw) +
		" " +
		use
			.map((c, s) => p.fg(SERIES[s % SERIES.length]!, clip(table.headers[c] ?? "", bw + 1 + nw)))
			.join(" ".repeat(gap));
	const out: string[] = [head];
	for (let i = 0; i < table.rows.length; i++) {
		let line = `${clip(names[i] ?? "", lw)} `;
		for (let s = 0; s < use.length; s++) {
			const v = parseNum(table.rows[i]![use[s]!] ?? "") ?? 0;
			const token = SERIES[s % SERIES.length]!;
			line += `${track(Math.abs(v) / peak, bw, p, token)} ${clip(fmt(v), nw, "right")}`;
			if (s < use.length - 1) line += " ".repeat(gap);
		}
		out.push(line);
	}
	return out;
}

function drawStacked(table: Table, cols: number[], width: number, p: Palette): string[] {
	const names = labels(table);
	const use = cols.slice(0, 5);
	const lw = labelW(names, 12);
	const sums = table.rows.map((row) =>
		use.map((c) => Math.max(0, parseNum(row[c] ?? "") ?? 0)).reduce((a, b) => a + b, 0),
	);
	const peak = Math.max(1, ...sums);
	const nw = numW(sums);
	const bw = Math.max(10, width - lw - nw - 2);
	const out: string[] = [legend(table, use, p)];
	for (let i = 0; i < table.rows.length; i++) {
		const parts = use.map((c) => Math.max(0, parseNum(table.rows[i]![c] ?? "") ?? 0));
		const sum = sums[i] ?? 0;
		const rowW = Math.max(sum > 0 ? 1 : 0, Math.round((sum / peak) * bw));
		let bar = "";
		let used = 0;
		for (let s = 0; s < parts.length; s++) {
			const w =
				s === parts.length - 1
					? Math.max(0, rowW - used)
					: Math.round((parts[s]! / (sum || 1)) * rowW);
			used += w;
			bar += p.fg(SERIES[s % SERIES.length]!, "█".repeat(w));
		}
		bar += p.fg("dim", "░".repeat(Math.max(0, bw - rowW)));
		out.push(`${clip(names[i] ?? "", lw)} ${bar} ${clip(fmt(sum), nw, "right")}`);
	}
	return out;
}

function drawLine(table: Table, cols: number[], width: number, p: Palette): string[] {
	const names = labels(table);
	const vals = table.rows.map((r) => parseNum(r[cols[0]!] ?? "") ?? 0);
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	const span = hi - lo || 1;
	const h = 7;
	const axis = Math.max(4, dw(fmt(hi)), dw(fmt(lo)));
	const w = Math.max(8, width - axis - 2);
	const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => " "));
	const xOf = (i: number) =>
		vals.length <= 1 ? 0 : Math.round((i * (w - 1)) / (vals.length - 1));
	const yOf = (v: number) => Math.round((1 - (v - lo) / span) * (h - 1));
	const pts = vals.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
	for (let i = 0; i < pts.length - 1; i++) {
		plotLine(grid, pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y);
	}
	for (const pt of pts) grid[pt.y]![pt.x] = "●";
	const out: string[] = [];
	for (let i = 0; i < h; i++) {
		const ylab = i === 0 ? fmt(hi) : i === h - 1 ? fmt(lo) : "";
		out.push(`${clip(ylab, axis, "right")}${p.fg("dim", "│")}${p.fg("accent", grid[i]!.join(""))}`);
	}
	out.push(`${" ".repeat(axis)}${p.fg("dim", `└${"─".repeat(w)}`)}`);
	const left = names[0] ?? "";
	const right = names[names.length - 1] ?? "";
	out.push(
		`${" ".repeat(axis + 1)}${p.fg("dim", clip(left, Math.floor(w / 2)) + clip(right, Math.ceil(w / 2), "right"))}`,
	);
	for (let s = 1; s < Math.min(cols.length, 3); s++) {
		const extra = table.rows.map((r) => parseNum(r[cols[s]!] ?? "") ?? 0);
		const elo = Math.min(...extra);
		const ehi = Math.max(...extra);
		const es = ehi - elo || 1;
		const spark = extra
			.map((v) => SPARK[Math.round(((v - elo) / es) * (SPARK.length - 1))] ?? "▁")
			.join("");
		const title = table.headers[cols[s]!] ?? `s${s + 1}`;
		out.push(
			`${p.fg("dim", clip(title, axis))}${p.fg(SERIES[s % SERIES.length]!, spark)} ${p.fg("dim", `${fmt(elo)}–${fmt(ehi)}`)}`,
		);
	}
	return out;
}

function plotLine(grid: string[][], x0: number, y0: number, x1: number, y1: number): void {
	const h = grid.length;
	const w = grid[0]?.length ?? 0;
	let dx = Math.abs(x1 - x0);
	const sx = x0 < x1 ? 1 : -1;
	let dy = -Math.abs(y1 - y0);
	const sy = y0 < y1 ? 1 : -1;
	let err = dx + dy;
	let x = x0;
	let y = y0;
	for (;;) {
		if ((x !== x1 || y !== y1) && y >= 0 && y < h && x >= 0 && x < w && grid[y]![x] === " ") {
			grid[y]![x] = "·";
		}
		if (x === x1 && y === y1) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y += sy;
		}
	}
}

function drawSlope(table: Table, cols: number[], width: number, p: Palette): string[] {
	const a = cols[0]!;
	const b = cols[1] ?? cols[0]!;
	const names = labels(table);
	const lw = labelW(names, 12);
	const froms = table.rows.map((r) => parseNum(r[a] ?? "") ?? 0);
	const tos = table.rows.map((r) => parseNum(r[b] ?? "") ?? 0);
	const nw = Math.max(numW(froms), numW(tos));
	const dwv = numW(froms.map((v, i) => (tos[i] ?? 0) - v));
	const mid = Math.max(6, width - lw - nw * 2 - dwv - 6);
	return names.map((name, i) => {
		const from = froms[i] ?? 0;
		const to = tos[i] ?? 0;
		const delta = to - from;
		const token: ColorToken = delta > 0 ? "success" : delta < 0 ? "error" : "muted";
		const arrow = delta >= 0 ? `${"─".repeat(Math.max(1, mid - 1))}▶` : `◀${"─".repeat(Math.max(1, mid - 1))}`;
		const sign = delta > 0 ? "+" : "";
		return `${clip(name, lw)} ${clip(fmt(from), nw, "right")} ${p.fg(token, arrow)} ${clip(fmt(to), nw, "right")} ${p.fg(token, clip(sign + fmt(delta), dwv + 1, "right"))}`;
	});
}

function drawShare(table: Table, cols: number[], width: number, p: Palette): string[] {
	const col = cols[0]!;
	const names = labels(table);
	const vals = table.rows.map((r) => Math.max(0, parseNum(r[col] ?? "") ?? 0));
	const sum = vals.reduce((a, b) => a + b, 0) || 1;
	const pcts = vals.map((v) => (v / sum) * 100);
	const lw = labelW(names, 12);
	const nw = Math.max(4, ...pcts.map((v) => dw(`${fmt(v)}%`)));
	const bw = Math.max(10, width - lw - nw - 2);
	let stacked = "";
	let used = 0;
	for (let i = 0; i < vals.length; i++) {
		const w =
			i === vals.length - 1
				? Math.max(0, bw - used)
				: Math.max(vals[i]! > 0 ? 1 : 0, Math.round((vals[i]! / sum) * bw));
		used += w;
		stacked += p.fg(SERIES[i % SERIES.length]!, "█".repeat(w));
	}
	const out = [`${clip("", lw)} ${stacked}`];
	for (let i = 0; i < vals.length; i++) {
		out.push(
			`${clip(names[i] ?? "", lw)} ${track(vals[i]! / sum, bw, p, SERIES[i % SERIES.length]!)} ${clip(`${fmt(pcts[i]!)}%`, nw, "right")}`,
		);
	}
	return out;
}

function drawHeatmap(table: Table, cols: number[], _width: number, p: Palette): string[] {
	const names = labels(table);
	const lw = labelW(names, 10);
	const vals = table.rows.flatMap((r) => cols.map((c) => parseNum(r[c] ?? "") ?? 0));
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	const span = hi - lo || 1;
	const cell = 2;
	const head = clip("", lw) + cols.map((c) => ` ${clip(table.headers[c] ?? "", cell)}`).join("");
	const out = [p.fg("dim", head)];
	for (let i = 0; i < table.rows.length; i++) {
		let row = clip(names[i] ?? "", lw);
		for (const c of cols) {
			const v = parseNum(table.rows[i]![c] ?? "") ?? 0;
			const t = (v - lo) / span;
			const ch = HEAT[Math.round(t * (HEAT.length - 1))] ?? "░";
			const token: ColorToken = t < 0.33 ? "muted" : t < 0.66 ? "warning" : "accent";
			row += ` ${p.fg(token, ch.repeat(cell))}`;
		}
		out.push(row);
	}
	return out;
}

function drawHistogram(table: Table, cols: number[], width: number, p: Palette): string[] {
	const vals = colValues(table, cols[0]!);
	if (vals.length === 0) return [];
	const bins = Math.min(8, Math.max(4, Math.round(Math.sqrt(vals.length))));
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	const span = hi - lo || 1;
	const counts = Array.from({ length: bins }, () => 0);
	for (const v of vals) {
		const i = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
		counts[i]!++;
	}
	const peak = Math.max(1, ...counts);
	const labels = counts.map((_, i) => {
		const a = lo + (span * i) / bins;
		const b = lo + (span * (i + 1)) / bins;
		return `${fmt(a)}–${fmt(b)}`;
	});
	const lw = Math.max(8, ...labels.map(dw));
	const nw = numW(counts);
	const bw = Math.max(8, width - lw - nw - 2);
	return counts.map((c, i) => {
		return `${clip(labels[i] ?? "", lw)} ${track(c / peak, bw, p, "accent")} ${clip(String(c), nw, "right")}`;
	});
}

function drawScatter(table: Table, cols: number[], width: number, p: Palette): string[] {
	const xCol = cols[0]!;
	const yCol = cols[1] ?? cols[0]!;
	const pts = table.rows
		.map((r) => ({ x: parseNum(r[xCol] ?? ""), y: parseNum(r[yCol] ?? "") }))
		.filter((pt) => pt.x != null && pt.y != null) as { x: number; y: number }[];
	if (pts.length === 0) return [];
	const h = 8;
	const axis = Math.max(4, dw(fmt(Math.max(...pts.map((pt) => pt.y)))), dw(fmt(Math.min(...pts.map((pt) => pt.y)))));
	const w = Math.min(40, Math.max(16, width - axis - 2));
	const xs = pts.map((pt) => pt.x);
	const ys = pts.map((pt) => pt.y);
	const x0 = Math.min(...xs);
	const x1 = Math.max(...xs);
	const y0 = Math.min(...ys);
	const y1 = Math.max(...ys);
	const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => " "));
	for (const pt of pts) {
		const x = Math.round(((pt.x - x0) / (x1 - x0 || 1)) * (w - 1));
		const y = Math.round((1 - (pt.y - y0) / (y1 - y0 || 1)) * (h - 1));
		grid[y]![x] = "●";
	}
	const out = grid.map((row, i) => {
		const label = i === 0 ? fmt(y1) : i === h - 1 ? fmt(y0) : "";
		return `${clip(label, axis, "right")}${p.fg("dim", "│")}${p.fg("accent", row.join(""))}`;
	});
	out.push(`${" ".repeat(axis)}${p.fg("dim", `└${"─".repeat(w)}`)}`);
	out.push(
		`${" ".repeat(axis + 1)}${p.fg("dim", clip(fmt(x0), Math.floor(w / 2)) + clip(fmt(x1), Math.ceil(w / 2), "right"))}`,
	);
	return out;
}

function drawStat(table: Table, cols: number[], p: Palette): string[] {
	const row = table.rows[0] ?? [];
	const use = cols.slice(0, 4);
	const nums = use.map((c) => fmt(parseNum(row[c] ?? "") ?? 0));
	const heads = use.map((c) => table.headers[c] ?? "");
	const widths = use.map((_, i) => Math.max(6, dw(nums[i]!), dw(heads[i]!), 4));
	return [
		`  ${nums.map((n, i) => p.fg("accent", clip(n, widths[i]!, "right"))).join("  ")}`,
		`  ${heads.map((h, i) => p.fg("dim", clip(h, widths[i]!, "right"))).join("  ")}`,
	];
}

function drawProgress(table: Table, cols: number[], width: number, p: Palette): string[] {
	const names = labels(table);
	const lw = labelW(names, 14);
	const texts = table.rows.map((row) => {
		const v = parseNum(row[cols[0]!] ?? "") ?? 0;
		const max = cols[1] != null ? parseNum(row[cols[1]] ?? "") : null;
		return max != null ? `${fmt(v)}/${fmt(max)}` : `${fmt((v > 1 ? v : v * 100))}%`;
	});
	const nw = Math.max(4, ...texts.map(dw));
	const bw = Math.max(10, width - lw - nw - 2);
	return table.rows.map((row, i) => {
		const v = parseNum(row[cols[0]!] ?? "") ?? 0;
		const max = cols[1] != null ? parseNum(row[cols[1]] ?? "") : null;
		const frac = max != null && max > 0 ? v / max : v > 1 ? v / 100 : v;
		return `${clip(names[i] ?? "", lw)} ${track(frac, bw, p, "accent")} ${clip(texts[i] ?? "", nw, "right")}`;
	});
}

function drawDiverging(table: Table, cols: number[], width: number, p: Palette): string[] {
	const col = cols[0]!;
	const names = labels(table);
	const vals = table.rows.map((r) => parseNum(r[col] ?? "") ?? 0);
	const peak = maxAbs(vals);
	const lw = labelW(names, 12);
	const nw = numW(vals);
	const half = Math.max(6, Math.floor((width - lw - nw - 4) / 2));
	return names.map((name, i) => {
		const v = vals[i] ?? 0;
		const n = Math.round((Math.abs(v) / peak) * half);
		const left =
			v < 0
				? `${" ".repeat(Math.max(0, half - n))}${p.fg("error", "█".repeat(n))}`
				: " ".repeat(half);
		const right =
			v > 0
				? `${p.fg("success", "█".repeat(n))}${p.fg("dim", "░".repeat(Math.max(0, half - n)))}`
				: p.fg("dim", "░".repeat(half));
		return `${clip(name, lw)} ${left}${p.fg("dim", "│")}${right} ${clip(fmt(v), nw, "right")}`;
	});
}

function legend(table: Table, cols: number[], p: Palette): string {
	return cols
		.map((c, i) => p.fg(SERIES[i % SERIES.length]!, table.headers[c] ?? `s${i + 1}`))
		.join("  ");
}
