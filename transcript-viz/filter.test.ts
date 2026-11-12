import assert from "node:assert/strict";
import test from "node:test";
import { heuristicKind, worthCharting } from "./filter.ts";
import { SAMPLES } from "./samples.ts";

test("rejects id indexes and text-heavy tables", () => {
	assert.equal(
		worthCharting({
			headers: ["id", "name"],
			rows: [
				["1", "a"],
				["2", "b"],
				["3", "c"],
			],
		}),
		false,
	);
	assert.equal(
		worthCharting({
			headers: ["file", "note"],
			rows: [["a.ts", "x".repeat(60)], ["b.ts", "y".repeat(60)]],
		}),
		false,
	);
});

test("accepts sample tables", () => {
	for (const sample of SAMPLES) {
		assert.equal(worthCharting(sample.table), true, sample.title);
	}
});

test("heuristic is conservative on a 2-col category table", () => {
	assert.equal(
		heuristicKind({
			headers: ["item", "count"],
			rows: [
				["a", "10"],
				["b", "20"],
				["c", "15"],
			],
		}),
		"bar",
	);
});
