import assert from "node:assert/strict";
import test from "node:test";

const { NUDGE_INTERVAL_MS, buildNudge, default: install, readState, shouldNudge } = await import(
	"./task-progress-nudge.ts"
);

const entry = (state, enabled = true) => ({
	type: "custom",
	customType: "simple-task-state",
	data: { state, enabled },
});
const list = (...statuses) => ({
	active: true,
	tasks: statuses.map((status, i) => ({ id: i + 1, text: `Task ${i + 1}`, status })),
});

test("readState takes the last snapshot on the branch and honours /tasks off", () => {
	const branch = [entry(list("pending", "in_progress")), entry(list("done", "done", "in_progress"))];
	assert.equal(readState(branch).tasks.length, 3);
	assert.equal(readState([...branch, entry(list("pending"), false)]), undefined);
	assert.equal(readState([{ type: "message" }]), undefined);
	assert.equal(readState([]), undefined);
});

test("buildNudge names the running task and the progress, silent otherwise", () => {
	assert.match(buildNudge(list("done", "in_progress", "pending")), /#2 "Task 2".*\(1\/3 done\)/);
	assert.equal(buildNudge({ active: false, tasks: [{ id: 1, text: "x", status: "in_progress" }] }), undefined);
	assert.equal(buildNudge(undefined), undefined);
	assert.equal(buildNudge(list("done", "done")), undefined);
});

test("buildNudge still fires when nothing is in_progress", () => {
	// 回归：模型只 task_set 就干活、从没标 in_progress，那时旧逻辑一声不响。
	assert.match(buildNudge(list("pending", "pending")), /nothing is in_progress \(0\/2 done\).*#1 "Task 1"/);
	assert.match(buildNudge(list("done", "pending")), /nothing is in_progress \(1\/2 done\).*#2 "Task 2"/);
});

test("shouldNudge waits for 90s of silence on both sides", () => {
	const now = 1_000_000;
	assert.equal(shouldNudge(now, now - NUDGE_INTERVAL_MS, 0), true);
	assert.equal(shouldNudge(now, now - 60_000, 0), false);
	assert.equal(shouldNudge(now, now - NUDGE_INTERVAL_MS, now - 30_000), false);
});

test("wiring: one nudge per 90s of silence, none right after a task_update", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const handlers = new Map();
	install({ on: (name, fn) => handlers.set(name, fn) });
	const emit = (name, event, ctx) => handlers.get(name)?.(event, ctx);
	const ctx = { sessionManager: { getBranch: () => [entry(list("in_progress", "pending"))] } };
	const result = { content: [{ type: "text", text: "ok" }], structuredContent: { keep: 1 } };
	const bash = (over = {}) => emit("tool_result", { toolName: "bash", input: {}, isError: false, ...result, ...over }, ctx);

	emit("session_start", {}, ctx);
	assert.equal(bash(), undefined, "no nag before the list is 90s stale");
	t.mock.timers.tick(NUDGE_INTERVAL_MS);
	const nudged = bash();
	assert.equal(nudged.content.length, 2);
	assert.match(nudged.content[1].text, /#1 "Task 1" is still in_progress/);
	assert.deepEqual(nudged.structuredContent, { keep: 1 }, "structuredContent survives");

	assert.equal(bash(), undefined, "throttled: one nudge per 90s");
	emit("tool_call", { toolName: "task_update", input: {} }, ctx);
	t.mock.timers.tick(60_000);
	assert.equal(bash(), undefined, "the list was just updated — stay quiet");
	t.mock.timers.tick(30_000);
	assert.ok(bash(), "quiet again after 90s → nudge resumes");
});
