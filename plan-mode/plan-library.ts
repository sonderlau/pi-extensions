import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildPlanDocPath, PLAN_DOC_DIR } from "./plan-doc.ts";

export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function planRoot(cwd: string): string {
	const root = resolve(cwd, PLAN_DOC_DIR);
	assertNoSymlinks(root, resolve(cwd));
	return root;
}

export function listPlans(cwd: string): string[] {
	const root = planRoot(cwd);
	try {
		return readdirSync(root).filter((name) => {
			const stat = lstatSync(join(root, name));
			return name.endsWith(".md") && stat.isFile() && !stat.isSymbolicLink();
		}).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

export function resolvePlanPath(cwd: string, file: string): string {
	if (!file || file !== basename(file) || file.includes("\\") || !file.endsWith(".md") || file === ".md") {
		throw new Error("计划文件必须是 .pi/plans 下的 Markdown 文件名");
	}
	const path = join(planRoot(cwd), file);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("计划路径必须是普通文件，不能是符号链接");
	return path;
}

export function readPlan(cwd: string, file: string): { path: string; text: string; hash: string; version: string } {
	const path = resolvePlanPath(cwd, file);
	const stat = lstatSync(path);
	const text = readFileSync(path, "utf8");
	const hash = hashText(text);
	return { path, text, hash, version: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${hash}` };
}

export function savePlanSnapshot(cwd: string, text: string, slug?: string): string {
	if (!text.trim()) throw new Error("不能保存空计划");
	mkdirSync(planRoot(cwd), { recursive: true });
	for (let attempt = 0; attempt < 100; attempt++) {
		const path = buildPlanDocPath({ cwd, slug, exists: pathExists });
		try {
			writeNew(path, text);
			return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("无法为计划生成不冲突的文件名");
}

export function exportPlan(cwd: string, text: string, destination: string): string {
	const project = resolve(cwd);
	const target = resolve(project, destination);
	const fromProject = relative(project, target);
	if (!destination || isAbsolute(destination) || fromProject === ".." || fromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("导出路径必须位于项目目录内");
	}
	assertNoSymlinks(target, project);
	mkdirSync(dirname(target), { recursive: true });
	writeNew(target, text);
	return target;
}

export type PlanEditResult = { kind: "saved"; path: string } | { kind: "conflict" };

export function saveEditedPlan(cwd: string, file: string, originalVersion: string, text: string): PlanEditResult {
	if (!text.trim()) throw new Error("不能保存空计划");
	let original: ReturnType<typeof readPlan>;
	try { original = readPlan(cwd, file); }
	catch (error) {
		if (isMissing(error) || /符号链接/.test(String(error))) return { kind: "conflict" };
		throw error;
	}
	if (original.version !== originalVersion) return { kind: "conflict" };
	const temp = join(dirname(original.path), `.${basename(original.path)}.${randomUUID()}.tmp`);
	writeNew(temp, text);
	try {
		// shortcut: filesystem has no portable compare-and-swap rename; a writer racing after this check can still win.
		let latest: ReturnType<typeof readPlan>;
		try { latest = readPlan(cwd, file); }
		catch (error) {
			if (isMissing(error) || /符号链接/.test(String(error))) return { kind: "conflict" };
			throw error;
		}
		if (latest.version !== originalVersion) return { kind: "conflict" };
		renameSync(temp, original.path);
		return { kind: "saved", path: original.path };
	} finally {
		try { unlinkSync(temp); } catch (error) { if (!isMissing(error)) throw error; }
	}
}

function writeNew(path: string, text: string): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, text, "utf8");
	} catch (error) {
		try { unlinkSync(path); } catch { /* retain original error */ }
		throw error;
	} finally {
		closeSync(fd);
	}
}

function assertNoSymlinks(target: string, boundary: string): void {
	let cursor = resolve(target);
	const root = resolve(boundary);
	while (cursor === root || cursor.startsWith(`${root}/`)) {
		try {
			if (lstatSync(cursor).isSymbolicLink()) throw new Error("计划路径不能经过符号链接");
		} catch (error) { if (!isMissing(error)) throw error; }
		if (cursor === root) break;
		cursor = dirname(cursor);
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) { if (isMissing(error)) return false; throw error; }
}
