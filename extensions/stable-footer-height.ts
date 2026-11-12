/**
 * Keep the bottom status footer at 2 rows.
 * Zentui Starship reflows between 1 and 2 lines as git/status width changes;
 * that resize is the flicker. Empty footers stay empty (Hidden).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARK = Symbol.for("sonderlau.stable-footer-height");
const ORIGINAL = Symbol.for("sonderlau.stable-footer-height.original");
export const STABLE_FOOTER_LINES = 2;

type FooterFactory = (tui: unknown, theme: unknown, footerData: unknown) => {
	render: (width: number) => string[];
};

type SetFooter = (factory?: unknown) => void;

export function padFooterLines(lines: string[], minLines = STABLE_FOOTER_LINES): string[] {
	if (lines.length === 0 || lines.length >= minLines) return lines;
	const padded = lines.slice();
	while (padded.length < minLines) padded.push("");
	return padded;
}

export function wrapFooterFactory(factory: FooterFactory): FooterFactory {
	const marked = factory as FooterFactory & { [MARK]?: boolean };
	if (marked[MARK]) return factory;
	const wrapped: FooterFactory = (tui, theme, footerData) => {
		const component = factory(tui, theme, footerData);
		const render = component.render.bind(component);
		component.render = (width) => {
			const lines = render(width);
			return Array.isArray(lines) ? padFooterLines(lines) : lines;
		};
		return component;
	};
	(wrapped as FooterFactory & { [MARK]?: boolean })[MARK] = true;
	return wrapped;
}

export function wrapSetFooter(setFooter: SetFooter): SetFooter {
	const marked = setFooter as SetFooter & { [MARK]?: boolean; [ORIGINAL]?: SetFooter };
	const original = marked[ORIGINAL] ?? setFooter;
	const wrapped: SetFooter = function (this: unknown, factory?: unknown) {
		const next = typeof factory === "function" ? wrapFooterFactory(factory as FooterFactory) : factory;
		return original.call(this, next);
	};
	(wrapped as SetFooter & { [MARK]?: boolean; [ORIGINAL]?: SetFooter })[MARK] = true;
	(wrapped as SetFooter & { [ORIGINAL]?: SetFooter })[ORIGINAL] = original;
	return wrapped;
}

export function installStableFooterHeight(target: { setExtensionFooter?: SetFooter }): void {
	if (typeof target.setExtensionFooter !== "function") return;
	target.setExtensionFooter = wrapSetFooter(target.setExtensionFooter);
}

export default function stableFooterHeight(pi: ExtensionAPI) {
	// Dynamic: a static import resolves a different module instance outside Pi's loader.
	void import("@earendil-works/pi-coding-agent")
		.then((mod) => {
			const proto = (mod as { InteractiveMode?: { prototype: { setExtensionFooter?: SetFooter } } })
				.InteractiveMode?.prototype;
			if (proto) installStableFooterHeight(proto);
		})
		.catch(() => {
			// session_start still wraps ctx.ui.setFooter
		});
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as { setFooter?: SetFooter & { [MARK]?: boolean } };
		if (typeof ui.setFooter !== "function" || ui.setFooter[MARK]) return;
		try {
			ui.setFooter = wrapSetFooter(ui.setFooter.bind(ui));
		} catch {
			// prototype patch is the other path
		}
	});
}
