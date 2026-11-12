/**
 * PageUp/PageDown jump a full viewport, so the line you were reading teleports.
 * One page scroll eases over ~150ms. A second page while that runs, or key
 * repeat, cancels and jumps. Arrow keys and the mouse wheel stay instant.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARK = Symbol.for("sonderlau.smooth-page-scroll");
const WIDGET_KEY = "smooth-page-scroll";

export const LINE_SCROLL_MAX = 3;
export const FRAME_MS = 16;
export const FRAME_COUNT = 10;
export const REPEAT_GAP_MS = 80;

type ScrollBy = (lines: number) => void;

export function frameDeltas(lines: number, frameCount = FRAME_COUNT): number[] {
	const total = Math.trunc(lines);
	const abs = Math.abs(total);
	if (abs === 0) return [];
	const frames = Math.min(Math.max(1, frameCount), abs);
	const sign = Math.sign(total);
	const base = Math.floor(abs / frames);
	let extra = abs % frames;
	const out: number[] = [];
	for (let i = 0; i < frames; i++) {
		const n = base + (extra > 0 ? 1 : 0);
		if (extra > 0) extra--;
		out.push(sign * n);
	}
	return out;
}

export function createPageScroll(
	original: ScrollBy,
	opts?: {
		now?: () => number;
		schedule?: (fn: () => void, ms: number) => unknown;
		clear?: (handle: unknown) => void;
	},
): ScrollBy {
	const now = opts?.now ?? (() => performance.now());
	const schedule = opts?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const clear = opts?.clear ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let pending = 0;
	let timer: unknown;
	let lastLargeAt = -Infinity;
	let repeating = false;

	const wrapped: ScrollBy = (lines) => {
		if (!Number.isFinite(lines) || lines === 0 || Math.abs(lines) <= LINE_SCROLL_MAX) {
			original(lines);
			return;
		}
		const t = now();
		const snapping = timer !== undefined || (repeating && t - lastLargeAt < REPEAT_GAP_MS);
		lastLargeAt = t;
		if (snapping) {
			if (timer !== undefined) {
				clear(timer);
				timer = undefined;
			}
			const jump = pending + lines;
			pending = 0;
			repeating = true;
			original(jump);
			return;
		}
		repeating = false;
		pending = lines;
		const deltas = frameDeltas(lines);
		let i = 0;
		const tick = () => {
			const slice = deltas[i++];
			pending -= slice;
			original(slice);
			if (i < deltas.length) timer = schedule(tick, FRAME_MS);
			else timer = undefined;
		};
		tick();
	};
	(wrapped as ScrollBy & { [MARK]?: boolean })[MARK] = true;
	return wrapped;
}

export function installSmoothPageScroll(tui: { scrollBy?: ScrollBy }): boolean {
	const scrollBy = tui?.scrollBy;
	if (typeof scrollBy !== "function") return false;
	if ((scrollBy as ScrollBy & { [MARK]?: boolean })[MARK]) return true;
	tui.scrollBy = createPageScroll(scrollBy.bind(tui));
	return true;
}

export default function smoothPageScroll(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as {
			setWidget?: (
				key: string,
				content?: ((tui: { scrollBy?: ScrollBy }) => { render: () => string[] }) | undefined,
			) => void;
		};
		if (typeof ui.setWidget !== "function") return;
		// Factory is only a way to reach the live TUI. The bundle is a different
		// module instance, so an imported prototype misses the page keys.
		let captured = false;
		ui.setWidget(WIDGET_KEY, (tui) => {
			captured = true;
			installSmoothPageScroll(tui);
			return { render: () => [] };
		});
		if (captured) ui.setWidget(WIDGET_KEY, undefined);
	});
}
