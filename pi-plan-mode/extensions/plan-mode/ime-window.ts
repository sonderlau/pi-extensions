import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ImeWindow = "prompt" | "browse" | "comment";

let current: ImeWindow | undefined;
let handler: (window: ImeWindow) => void = () => {};

export function imeRequestLine(window: ImeWindow, now = Date.now()): string {
	return `${window} ${Math.floor(now / 1000)}\n`;
}

export function setImeWindowHandler(next: (window: ImeWindow) => void): void {
	handler = next;
}

export function beginImeReview(): void {
	current = undefined;
}

/** 只在逻辑窗口变化时通知输入法，避免点击输入框内部反复切换。 */
export function activateImeWindow(window: ImeWindow): void {
	if (window === current) return;
	current = window;
	handler(window);
}

export function installLiveImeWindow(): void {
	setImeWindowHandler((window) => {
		if (process.env.NODE_TEST_CONTEXT || process.env.PI_PLAN_IME === "off") return;
		try {
			writeFileSync(join(homedir(), "Library/Rime/pi-ime-window.request"), imeRequestLine(window));
			const child = spawn("osascript", ["-e", 'tell application "System Events" to key code 79'], { detached: true, stdio: "ignore" });
			child.unref();
		} catch {
			// 没有辅助功能权限时不打断审阅；右 Command 仍可手动切换。
		}
	});
}
