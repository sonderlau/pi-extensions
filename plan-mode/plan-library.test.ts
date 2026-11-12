import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPlan, hashText, listPlans, readPlan, resolvePlanPath, saveEditedPlan, savePlanSnapshot } from "./plan-library.ts";

function workspace(): { cwd: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-library-"));
	return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test("snapshot uses SHA-256 and never overwrites a collision", () => {
	const { cwd, cleanup } = workspace();
	try {
		assert.equal(hashText("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		const one = savePlanSnapshot(cwd, "# approved", "snapshot-test");
		const two = savePlanSnapshot(cwd, "# second", "snapshot-test");
		assert.notEqual(one, two);
		assert.equal(fs.readFileSync(one, "utf8"), "# approved");
		assert.equal(fs.statSync(one).mode & 0o777, 0o600);
	} finally { cleanup(); }
});

test("list/read restrict to ordinary markdown files in the plans directory", () => {
	const { cwd, cleanup } = workspace();
	try {
		const plans = path.join(cwd, ".pi", "plans");
		fs.mkdirSync(plans, { recursive: true });
		fs.writeFileSync(path.join(plans, "a.md"), "A");
		fs.writeFileSync(path.join(plans, "ignore.txt"), "x");
		fs.symlinkSync(path.join(plans, "a.md"), path.join(plans, "link.md"));
		assert.deepEqual(listPlans(cwd), ["a.md"]);
		assert.equal(readPlan(cwd, "a.md").text, "A");
		assert.throws(() => resolvePlanPath(cwd, "../outside.md"));
		assert.throws(() => resolvePlanPath(cwd, "link.md"));
	} finally { cleanup(); }
});

test("export is exclusive and edit detects changes, deletion, and replacement", () => {
	const { cwd, cleanup } = workspace();
	try {
		const pathA = savePlanSnapshot(cwd, "A", "edit-test");
		const file = path.basename(pathA);
		const original = readPlan(cwd, file);
		assert.equal(saveEditedPlan(cwd, file, original.version, "B").kind, "saved");
		assert.equal(fs.readFileSync(pathA, "utf8"), "B");
		assert.equal(saveEditedPlan(cwd, file, original.version, "C").kind, "conflict");
		const changed = readPlan(cwd, file);
		assert.throws(() => exportPlan(cwd, "export", path.relative(cwd, pathA)), { code: "EEXIST" });
		const outside = path.join(cwd, "export", "copy.md");
		assert.equal(exportPlan(cwd, "export", path.relative(cwd, outside)), outside);
		assert.equal(fs.readFileSync(outside, "utf8"), "export");
		assert.throws(() => exportPlan(cwd, "escape", "../outside.md"), /项目目录内/);
		fs.unlinkSync(pathA);
		assert.equal(saveEditedPlan(cwd, file, changed.version, "C").kind, "conflict");
	} finally { cleanup(); }
});

test("plans root symlink is rejected", () => {
	const { cwd, cleanup } = workspace();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "plan-outside-"));
	try {
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.symlinkSync(outside, path.join(cwd, ".pi", "plans"));
		assert.throws(() => savePlanSnapshot(cwd, "secret", "escape"));
	} finally { cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});
