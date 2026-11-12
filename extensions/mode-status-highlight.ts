/**
 * bypass / plan / dangerous are mode names, not decoration.
 * Zentui's default extension-status color is gray and strips publisher SGR
 * unless plan-mode is set to original in zentui.json. Bold survives fg's
 * foreground reset (\x1b[39m).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARK = Symbol.for("sonderlau.mode-status-highlight");
const STATUS_KEY = "plan-mode";

export function emphasizeModeStatus(text: string): string {
	if (text.includes("\x1b[1m")) return text;
	return `\x1b[1m${text}\x1b[22m`;
}

export default function modeStatusHighlight(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as {
			setStatus?: (key: string, value: string | undefined) => void;
		};
		const setStatus = ui.setStatus;
		if (typeof setStatus !== "function" || (setStatus as { [MARK]?: boolean })[MARK]) return;
		const wrapped = function (this: unknown, key: string, value: string | undefined) {
			const next = key === STATUS_KEY && typeof value === "string" ? emphasizeModeStatus(value) : value;
			return setStatus.call(this === ui ? ctx.ui : this, key, next);
		};
		(wrapped as { [MARK]?: boolean })[MARK] = true;
		ui.setStatus = wrapped;
	});
}
