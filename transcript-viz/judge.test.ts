import assert from "node:assert/strict";
import test from "node:test";
import { parseKind } from "./kinds.ts";

test("parseKind reads JSON even when wrapped", () => {
	assert.equal(parseKind('{"kind":"bar"}'), "bar");
	assert.equal(parseKind("sure\n```json\n{\"kind\": \"heatmap\"}\n```"), "heatmap");
	assert.equal(parseKind("nope"), "none");
	assert.equal(parseKind('{"kind":"waterfall"}'), "none");
});
