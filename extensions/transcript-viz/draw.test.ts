import assert from "node:assert/strict";
import test from "node:test";
import { draw } from "./draw.ts";
import { SAMPLES } from "./samples.ts";

test("each family prints at least one line", () => {
	for (const sample of SAMPLES) {
		const lines = draw(sample.kind, sample.table, { width: 56 });
		assert.ok(lines.length > 0, sample.kind);
		assert.ok(lines.some((l) => l.trim().length > 0), sample.kind);
	}
});

test("none draws nothing", () => {
	assert.deepEqual(draw("none", SAMPLES[0]!.table), []);
});


test("bar progress histogram rows share a width", () => {
	for (const kind of ["bar", "progress", "histogram", "diverging"] as const) {
		const sample = SAMPLES.find((s) => s.kind === kind)!;
		const lines = draw(kind, sample.table, { width: 56 });
		const widths = new Set(lines.map((line) => [...line].length));
		assert.equal(widths.size, 1, kind);
	}
});
