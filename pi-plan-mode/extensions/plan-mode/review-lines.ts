/** 计划审阅的纯逻辑：行号、标题级别、交给模型的 `L150:` 意见。不依赖 TUI。 */

export interface PlanSourceLine {
	/** 1-based，和用户在文件里看到的行号一致。 */
	number: number;
	text: string;
	heading: 0 | 1 | 2 | 3 | 4 | 5 | 6;
	fence: boolean;
}

const HEADING = /^(#{1,6})(?:\s+(.*))?$/;

export function parsePlanLines(plan: string): PlanSourceLine[] {
	const raw = plan.replace(/\r\n/g, "\n").split("\n");
	let inFence = false;
	return raw.map((text, index) => {
		const marker = text.trimStart().startsWith("```");
		const heading = !inFence && !marker ? headingLevel(text) : 0;
		const fence = inFence || marker;
		if (marker) inFence = !inFence;
		return { number: index + 1, text, heading, fence };
	});
}

export function headingLevel(text: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
	const match = HEADING.exec(text.trim());
	if (!match) return 0;
	return match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
}

export function headingText(text: string): string {
	const match = HEADING.exec(text.trim());
	return match?.[2] ?? text;
}

export function formatDocumentComment(text: string): string {
	return `Document: ${text.trim()}`;
}

/** 交给模型的一行意见。行号是计划原文的 1-based 行，不是屏幕上的折行。 */
export function formatLineComment(lineNumber: number, text: string): string {
	return `L${lineNumber}: ${text.trim()}`;
}
