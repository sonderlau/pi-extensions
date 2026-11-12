/**
 * Aggregator entry: auto-discovery loads `ui-polish/index.ts`, which wires
 * the single-file UI extensions in this directory in one go.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modeStatusHighlight from "./mode-status-highlight.ts";
import smoothPageScroll from "./smooth-page-scroll.ts";
import stableFooterHeight from "./stable-footer-height.ts";
import stepLedger from "./step-ledger.ts";
import taskProgressNudge from "./task-progress-nudge.ts";

export default function uiPolish(pi: ExtensionAPI): void {
	modeStatusHighlight(pi);
	smoothPageScroll(pi);
	stableFooterHeight(pi);
	stepLedger(pi);
	taskProgressNudge(pi);
}
