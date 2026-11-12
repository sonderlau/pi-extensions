import assert from "node:assert/strict";
import test from "node:test";

const { emphasizeModeStatus } = await import("./mode-status-highlight.ts");

test("bolds a colored mode label without dropping its color", () => {
	const colored = "\x1b[32m⏵ bypass\x1b[39m";
	assert.equal(emphasizeModeStatus(colored), `\x1b[1m${colored}\x1b[22m`);
});

test("does not stack bold", () => {
	const once = emphasizeModeStatus("plan");
	assert.equal(emphasizeModeStatus(once), once);
});
