import assert from "node:assert/strict";
import test from "node:test";
import { activityFromTool, clearSequences, statusSequences, tabTitle } from "./status.ts";

test("working report sets indeterminate progress, tab text, and program status", () => {
	const bytes = statusSequences({ phase: "working", detail: "读 README", folder: "pi-agent", });
	assert.match(bytes, /\x1b\]0;⚡ pi · pi-agent · 读 README\x07/);
	assert.match(bytes, /\x1b\]9;3;⚡ pi · pi-agent · 读 README\x07/);
	assert.match(bytes, /\x1b\]9;4;3\x07/);
	assert.match(bytes, /\x1b\]7501;state=working:app=pi:msg=/);
});

test("confirmation uses the paused progress state", () => {
	const bytes = statusSequences({ phase: "blocked", detail: "删除文件？", folder: "app", kind: "permission" });
	assert.match(bytes, /\x1b\]9;4;4\x07/);
	assert.match(bytes, /state=blocked:app=pi:msg=.*:kind=permission/);
	assert.match(tabTitle({ phase: "blocked", detail: "删除文件？", folder: "app", kind: "permission" }), /^✋ /);
	assert.match(tabTitle({ phase: "blocked", detail: "用哪个？", folder: "app", kind: "question" }), /^❓ /);
	assert.match(tabTitle({ phase: "done", detail: "改完了", folder: "app" }), /^✅ /);
	assert.match(tabTitle({ phase: "error", detail: "失败", folder: "app" }), /^❌ /);
});

test("done and error use distinct progress states", () => {
	assert.match(statusSequences({ phase: "done", detail: "改完了", folder: "app" }), /\x1b\]9;4;1;100\x07/);
	assert.match(statusSequences({ phase: "error", detail: "失败", folder: "app" }), /\x1b\]9;4;2\x07/);
	assert.match(statusSequences({ phase: "idle", detail: "", folder: "app" }), /\x1b\]9;4;0\x07/);
});

test("control characters never reach the title", () => {
	const title = tabTitle({ phase: "working", detail: "a;\x1b]0;hack\x07", folder: "app" });
	assert.equal(title.includes("\x1b"), false);
	assert.equal(title.includes("\x07"), false);
});

test("question tools are reported as waiting", () => {
	assert.equal(activityFromTool("ask_user_question", { questions: [{ question: "用哪个？" }] }).blocked, true);
	assert.equal(activityFromTool("bash", { command: "ls\nrm" }).blocked, false);
	assert.match(activityFromTool("bash", { command: "ls\nrm" }).detail, /^ls$/);
});

test("shutdown clears progress and the program-status record", () => {
	const bytes = clearSequences();
	assert.match(bytes, /\x1b\]9;4;0\x07/);
	assert.match(bytes, /\x1b\]7501;state=clear:app=pi\x07/);
});
