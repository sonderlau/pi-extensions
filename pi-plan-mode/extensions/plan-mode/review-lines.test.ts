import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLineComment, headingLevel, parsePlanLines } from "./review-lines.ts";

describe("parsePlanLines", () => {
	it("标题按级别识别，代码块里的 # 不当标题", () => {
		const lines = parsePlanLines("# 一\n## 二\n普通\n```ts\n## 不是标题\n```\n");
		assert.equal(lines[0]?.heading, 1);
		assert.equal(lines[1]?.heading, 2);
		assert.equal(lines[2]?.heading, 0);
		assert.equal(lines[4]?.heading, 0);
		assert.equal(lines[4]?.fence, true);
		assert.equal(lines[5]?.fence, true);
	});

	it("行号从 1 开始，对应原文", () => {
		const lines = parsePlanLines("a\nb\n");
		assert.deepEqual(
			lines.map((line) => line.number),
			[1, 2, 3],
		);
	});
});

describe("formatLineComment", () => {
	it("交给模型的格式是 L行号: 意见", () => {
		assert.equal(formatLineComment(150, "  这里改成配置层  "), "L150: 这里改成配置层");
	});
});

describe("headingLevel", () => {
	it("## 是 2 级，不是另一种字号", () => {
		assert.equal(headingLevel("## 改审批界面"), 2);
		assert.equal(headingLevel("正文"), 0);
	});
});
