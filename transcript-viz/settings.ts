import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type VizSettings = {
	enabled: boolean;
	judge: boolean;
};

const DEFAULTS: VizSettings = { enabled: true, judge: true };

export function settingsPath(): string {
	return path.join(getAgentDir(), "transcript-viz.json");
}

export function loadSettings(): VizSettings {
	try {
		const raw = fs.readFileSync(settingsPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<VizSettings>;
		return {
			enabled: parsed.enabled !== false,
			judge: parsed.judge !== false,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(next: VizSettings): void {
	fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, "\t")}\n`);
}
