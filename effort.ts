/**
 * /effort is another name for /thinking. No extra behavior.
 * Built-in slash commands are handled before extension commands, so this
 * puts /thinking back in the editor and submits it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function thinkingCommand(args: string): string {
	const level = args.trim();
	return level ? `/thinking ${level}` : "/thinking";
}

export default function effortCommand(pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Set thinking level (same as /thinking)",
		handler: async (args, ctx) => {
			const command = thinkingCommand(args);
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Use /thinking. /effort only forwards to it in the TUI.", "info");
				return;
			}
			setTimeout(() => {
				ctx.ui.setEditorText(command);
				process.stdin.emit("data", "\r");
			}, 0);
		},
	});
}
