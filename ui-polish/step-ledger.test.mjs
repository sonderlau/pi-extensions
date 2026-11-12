import assert from "node:assert/strict";
import test from "node:test";

const { buildLedger, default: install, summarizeStep, withLedger } = await import("./step-ledger.ts");

const user = (text = "do it") => ({ role: "user", content: text });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (...calls) => ({ role: "assistant", content: calls });
const tool = (id, name, text, extra = {}) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	...extra,
});
const ledgerOf = (message) => message.content.at(-1).text;

test("summarizeStep takes the exit line, not the first line, and skips a JSON brace", () => {
	const bash = summarizeStep(
		{
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "stdout line\n\nCommand exited with code 1" }],
		},
		{ command: "npm test" },
	);
	assert.equal(bash.outcome, "error: Command exited with code 1");
	assert.equal(bash.hint, "npm test");
	assert.equal(bash.failed, true);

	const json = summarizeStep(
		{ toolName: "read", isError: true, content: [{ type: "text", text: "{\n  \"x\": 1\n}" }] },
		{ path: "a.ts" },
	);
	assert.equal(json.outcome, "error");
});

test("summarizeStep reports grep empties and limits without counting lines", () => {
	assert.equal(
		summarizeStep(
			{ toolName: "grep", content: [{ type: "text", text: "No matches found" }] },
			{ pattern: "foo", path: "src" },
		).outcome,
		"0 hits",
	);
	assert.equal(
		summarizeStep(
			{
				toolName: "grep",
				content: [{ type: "text", text: "a.ts:1: foo\nb.ts-2- bar" }],
				details: { matchLimitReached: 50 },
			},
			{ pattern: "foo" },
		).outcome,
		"≥50 hits",
	);
	assert.equal(summarizeStep({ toolName: "read", content: [{ type: "text", text: "ok" }] }, {}).outcome, "ok");
});

test("arg hints follow the tool, truncate, and fall back to -", () => {
	assert.equal(summarizeStep({ toolName: "bash" }, { command: `npm test\n--watch ${"x".repeat(100)}` }).hint, "npm test");
	const long = summarizeStep({ toolName: "bash" }, { command: "x".repeat(100) });
	assert.equal(long.hint.length, 80);
	assert.ok(long.hint.endsWith("…"));
	assert.equal(summarizeStep({ toolName: "grep" }, { pattern: "foo", path: "src/a.ts" }).hint, "foo — src/a.ts");
	assert.equal(summarizeStep({ toolName: "read" }, { path: "src/a.ts" }).hint, "src/a.ts");
	assert.equal(summarizeStep({ toolName: "bash" }, undefined).hint, "-");
});

test("buildLedger keeps eight lines, the full count, and a repeat warning", () => {
	const steps = Array.from({ length: 9 }, (_, i) => ({
		toolName: i >= 7 ? "grep" : "read",
		hint: i >= 7 ? "foo" : `f${i}.ts`,
		outcome: i === 3 ? "error: no" : "ok",
		failed: i === 3,
	}));
	const text = buildLedger(steps, true);
	assert.match(text, /^\[steps as of 9\] 9 tool calls since the last user message, 1 failed\. Earlier steps were compacted\./);
	assert.equal(text.includes("1 read f0.ts"), false);
	assert.match(text, /2 read f1\.ts — ok/);
	assert.match(text, /9 grep foo — ok/);
	assert.match(text, /Repeated grep foo\. Change approach instead of retrying\./);
	assert.equal(buildLedger(steps.slice(0, 1), false).startsWith("[steps as of 1] 1 tool call "), true);
});

test("withLedger counts only tool results after the last user message", () => {
	const messages = [
		user("first"),
		assistant(call("1", "read", { path: "old.ts" })),
		tool("1", "read", "old"),
		{ role: "custom", customType: "simple-task-context", content: "tasks" },
		{ role: "bashExecution", content: "ls" },
		{ role: "branchSummary", content: "branch" },
		user("second"),
		assistant(call("2", "grep", { pattern: "now" })),
		tool("2", "grep", "No matches found"),
	];
	const before = structuredClone(messages);
	const next = withLedger(messages);
	assert.deepEqual(messages, before);
	assert.equal(next[2], messages[2], "results before the latest user stay untouched");
	assert.match(ledgerOf(next.at(-1)), /\[steps as of 1\] 1 tool call since the last user message, 0 failed\./);
	assert.match(ledgerOf(next.at(-1)), /1 grep now — 0 hits/);
	assert.equal(ledgerOf(next.at(-1)).includes("Earlier steps"), false);
});

test("withLedger leaves the array alone when this turn has no tool results", () => {
	const messages = [user(), assistant(call("1", "read", { path: "a.ts" }))];
	const empty = [];
	assert.equal(withLedger(messages), messages);
	assert.equal(withLedger(empty), empty);
});

test("snapshots stay byte-stable and a repeat is judged on the last two steps", () => {
	const first = [
		user(),
		assistant(call("1", "bash", { command: "npm test" })),
		tool("1", "bash", "ok"),
	];
	const second = [
		...first,
		assistant(call("2", "bash", { command: "npm test" })),
		tool("2", "bash", "fail\n\nCommand exited with code 1", { isError: true }),
	];
	const third = [
		...second,
		assistant(call("3", "read", { path: "a.ts" })),
		tool("3", "read", "file"),
	];
	const at1 = withLedger(first);
	const at2 = withLedger(second);
	const at3 = withLedger(third);
	assert.equal(ledgerOf(at1[2]), ledgerOf(at2[2]));
	assert.equal(ledgerOf(at2[2]), ledgerOf(at3[2]));
	assert.equal(ledgerOf(at2[4]).includes("Repeated bash npm test"), true);
	assert.equal(ledgerOf(at3.at(-1)).includes("Repeated"), false);
	assert.match(ledgerOf(at3.at(-1)), /\[steps as of 3\] 3 tool calls since the last user message, 1 failed\./);
	assert.match(ledgerOf(at2[4]), /2 bash npm test — error: Command exited with code 1/);
});

test("toolCallId picks the matching arguments, compaction adds one sentence, marked content is not doubled", () => {
	const messages = [
		{ role: "compactionSummary", content: "earlier" },
		user(),
		assistant(call("a", "read", { path: "a.ts" }), call("b", "read", { path: "b.ts" })),
		tool("b", "read", "b"),
	];
	const once = withLedger(messages);
	assert.match(ledgerOf(once.at(-1)), /1 read b\.ts — ok/);
	assert.match(ledgerOf(once.at(-1)), /Earlier steps were compacted\./);
	assert.equal(once.at(-1).details, undefined);
	const twice = withLedger(once);
	assert.equal(twice, once);
	assert.equal(once.at(-1).content.length, 2);
});

test("wiring returns undefined until a tool result exists, and does not mutate the event", () => {
	const handlers = new Map();
	install({ on: (name, fn) => handlers.set(name, fn) });
	const quiet = { messages: [user()] };
	assert.equal(handlers.get("context")(quiet), undefined);

	const event = {
		messages: [user(), assistant(call("1", "read", { path: "a.ts" })), tool("1", "read", "ok", { details: { keep: 1 } })],
	};
	const result = handlers.get("context")(event);
	assert.notEqual(result.messages, event.messages);
	assert.equal(event.messages[2].content.length, 1);
	assert.equal(result.messages[2].details.keep, 1);
	assert.match(ledgerOf(result.messages[2]), /1 read a\.ts — ok/);
});
