export type Table = {
	headers: string[];
	rows: string[][];
};

const FENCE = /^\s*```/;
const ROW = /^\s*\|.*\|\s*$/;
const SEP_CELL = /^:?-{3,}:?$/;

export function parseNum(cell: string): number | null {
	const t = cell.trim().replace(/,/g, "");
	if (!t || t === "-" || t === "—") return null;
	const pct = t.endsWith("%");
	const n = Number(pct ? t.slice(0, -1) : t);
	return Number.isFinite(n) ? n : null;
}

export function numericColumns(table: Table): number[] {
	const cols: number[] = [];
	for (let c = 0; c < table.headers.length; c++) {
		let hits = 0;
		let cells = 0;
		for (const row of table.rows) {
			const raw = row[c] ?? "";
			if (!raw.trim()) continue;
			cells++;
			if (parseNum(raw) != null) hits++;
		}
		if (cells > 0 && hits >= Math.ceil(cells * 0.6)) cols.push(c);
	}
	return cols;
}

export function labelColumn(table: Table): number | null {
	const nums = new Set(numericColumns(table));
	for (let c = 0; c < table.headers.length; c++) {
		if (!nums.has(c)) return c;
	}
	return null;
}

export function colValues(table: Table, col: number): number[] {
	const out: number[] = [];
	for (const row of table.rows) {
		const n = parseNum(row[col] ?? "");
		if (n != null) out.push(n);
	}
	return out;
}

export function formatTable(table: Table): string {
	const width = table.headers.map((h, c) =>
		Math.max(
			h.length,
			...table.rows.map((r) => (r[c] ?? "").length),
		),
	);
	const row = (cells: string[]) =>
		`| ${cells.map((c, i) => (c ?? "").padEnd(width[i] ?? 0)).join(" | ")} |`;
	const sep = `| ${width.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`;
	return [row(table.headers), sep, ...table.rows.map(row)].join("\n");
}

export function parseTables(md: string): Table[] {
	const lines = md.split(/\r?\n/);
	const out: Table[] = [];
	let i = 0;
	let fence = false;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (FENCE.test(line)) {
			fence = !fence;
			i++;
			continue;
		}
		if (fence) {
			i++;
			continue;
		}
		if (ROW.test(line) && i + 1 < lines.length && isSep(lines[i + 1] ?? "")) {
			const headers = splitRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && ROW.test(lines[i] ?? "") && !isSep(lines[i] ?? "")) {
				rows.push(fit(splitRow(lines[i] ?? ""), headers.length));
				i++;
			}
			if (headers.length > 0 && rows.length > 0) out.push({ headers, rows });
			continue;
		}
		i++;
	}
	return out;
}

function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").map((c) => c.trim());
}

function isSep(line: string): boolean {
	if (!ROW.test(line)) return false;
	const cells = splitRow(line);
	return cells.length > 0 && cells.every((c) => SEP_CELL.test(c.replace(/\s/g, "")));
}

function fit(cells: string[], n: number): string[] {
	const out = cells.slice(0, n);
	while (out.length < n) out.push("");
	return out;
}
