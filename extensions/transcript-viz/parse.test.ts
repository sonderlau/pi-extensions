import assert from "node:assert/strict";
import test from "node:test";
import { numericColumns, parseNum, parseTables } from "./parse.ts";

test("parseNum strips commas and percents", () => {
	assert.equal(parseNum("1,200"), 1200);
	assert.equal(parseNum("45%"), 45);
	assert.equal(parseNum("—"), null);
	assert.equal(parseNum("n/a"), null);
});

test("parseTables reads GFM and skips fenced tables", () => {
	const md = `
| fruit | n |
| ----- | --- |
| apple | 3 |
| pear  | 1 |

\`\`\`
| ignored | x |
| ------- | - |
| nope    | 9 |
\`\`\`
`;
	const tables = parseTables(md);
	assert.equal(tables.length, 1);
	assert.deepEqual(tables[0]?.headers, ["fruit", "n"]);
	assert.equal(tables[0]?.rows.length, 2);
	assert.deepEqual(numericColumns(tables[0]!), [1]);
});
