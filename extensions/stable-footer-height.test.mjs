import assert from "node:assert/strict";
import test from "node:test";

const { padFooterLines, wrapFooterFactory, wrapSetFooter } = await import("./stable-footer-height.ts");

test("pads a one-line footer to two and leaves empty or already-two alone", () => {
	assert.deepEqual(padFooterLines(["cwd"]), ["cwd", ""]);
	assert.deepEqual(padFooterLines(["a", "b"]), ["a", "b"]);
	assert.deepEqual(padFooterLines([]), []);
	assert.deepEqual(padFooterLines(["a", "b", "c"]), ["a", "b", "c"]);
});

test("wrapped footer render stays two lines", () => {
	const factory = wrapFooterFactory(() => ({
		render: () => ["only"],
	}));
	assert.deepEqual(factory({}, {}, {}).render(80), ["only", ""]);
	assert.equal(wrapFooterFactory(factory), factory);
});

test("setFooter wrapper pads and stays idempotent across reinstall", () => {
	const calls = [];
	const original = function (factory) {
		calls.push(factory);
		return factory;
	};
	const wrapped = wrapSetFooter(original);
	const again = wrapSetFooter(wrapped);
	const factory = () => ({ render: () => ["git"] });
	const installed = again.call({ marker: 1 }, factory);
	assert.equal(calls.length, 1);
	assert.deepEqual(installed({}, {}, {}).render(40), ["git", ""]);
	again.call({}, undefined);
	assert.equal(calls[1], undefined);
});
