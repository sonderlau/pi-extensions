import assert from "node:assert/strict";
import test from "node:test";

const { frameDeltas, createPageScroll, installSmoothPageScroll, default: smoothPageScroll } = await import(
	"./smooth-page-scroll.ts"
);

test("frame deltas sum to the page and stay within the frame count", () => {
	for (const lines of [4, 10, 36, -36, 7]) {
		const deltas = frameDeltas(lines, 10);
		assert.ok(deltas.length <= 10);
		assert.equal(deltas.reduce((sum, n) => sum + n, 0), Math.trunc(lines));
		assert.ok(deltas.every((n) => n !== 0 && Math.sign(n) === Math.sign(lines)));
	}
	assert.deepEqual(frameDeltas(0), []);
});

function fakeClock() {
	let now = 0;
	let pending = null;
	const applied = [];
	const scroll = createPageScroll((n) => applied.push(n), {
		now: () => now,
		schedule: (fn) => {
			pending = fn;
			return fn;
		},
		clear: () => {
			pending = null;
		},
	});
	return {
		applied,
		scroll,
		advance: (ms) => {
			now += ms;
		},
		flush: () => {
			const fn = pending;
			pending = null;
			fn?.();
		},
		get pending() {
			return pending;
		},
	};
}

test("one page tap steps; a second page snaps the rest", () => {
	const clock = fakeClock();
	clock.scroll(10);
	assert.deepEqual(clock.applied, [1]);
	clock.flush();
	assert.deepEqual(clock.applied, [1, 1]);
	clock.scroll(10);
	assert.deepEqual(clock.applied, [1, 1, 18]);
	assert.equal(clock.pending, null);
});

test("key repeat after a snap stays instant, a later tap eases again", () => {
	const clock = fakeClock();
	clock.scroll(8);
	clock.scroll(8);
	assert.deepEqual(clock.applied, [1, 15]);
	clock.advance(30);
	clock.scroll(8);
	assert.deepEqual(clock.applied, [1, 15, 8]);
	clock.advance(80);
	clock.scroll(8);
	assert.equal(clock.applied.at(-1), 1);
	assert.equal(clock.pending !== null, true);
});

test("arrow-sized scrolls stay instant and do not cancel a page ease", () => {
	const clock = fakeClock();
	clock.scroll(1);
	clock.scroll(-3);
	assert.deepEqual(clock.applied, [1, -3]);
	clock.scroll(10);
	clock.scroll(1);
	assert.deepEqual(clock.applied, [1, -3, 1, 1]);
	assert.equal(clock.pending !== null, true);
});

test("session_start patches the live tui and removes the probe widget", () => {
	let handler;
	const pi = {
		on(name, fn) {
			assert.equal(name, "session_start");
			handler = fn;
		},
	};
	smoothPageScroll(pi);
	const applied = [];
	const tui = {
		scrollBy(lines) {
			applied.push(lines);
		},
	};
	let widget;
	const ui = {
		setWidget(key, content) {
			if (typeof content === "function") {
				content(tui);
				widget = key;
				return;
			}
			assert.equal(key, "smooth-page-scroll");
			widget = undefined;
		},
	};
	handler({}, { hasUI: true, ui });
	assert.equal(widget, undefined);
	tui.scrollBy(1);
	assert.deepEqual(applied, [1]);
	assert.equal(installSmoothPageScroll(tui), true);
	tui.scrollBy(1);
	assert.deepEqual(applied, [1, 1]);
});
