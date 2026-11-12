/**
 * Aggregator entry: auto-discovery loads `ui-polish/index.ts`, which wires
 * the three single-file UI extensions in this directory in one go.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modeStatusHighlight from "./mode-status-highlight.ts";
import stableFooterHeight from "./stable-footer-height.ts";
import taskProgressNudge from "./task-progress-nudge.ts";

export default function uiPolish(pi: ExtensionAPI): void {
	modeStatusHighlight(pi);
	stableFooterHeight(pi);
	taskProgressNudge(pi);
}
