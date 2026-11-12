import assert from "node:assert/strict";
import test from "node:test";
import { draw } from "./draw.ts";
import { SAMPLES } from "./samples.ts";

test("print every family for review", () => {
	for (const sample of SAMPLES) {
		const lines = draw(sample.kind, sample.table, { width: 56 });
		console.log(`\n── ${sample.kind} · ${sample.title} ──`);
		for (const line of lines) console.log(line);
		assert.ok(lines.length > 0, sample.kind);
	}
});
