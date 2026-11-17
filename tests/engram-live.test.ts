import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngramSnapshot } from "../lib/cards/engram.ts";
import { createEngramProvider, ENGRAM_MIN_REFRESH_MS } from "../lib/cards/engram-live.ts";

const online = (memories: number): EngramSnapshot => ({ status: "online", version: "3.7.0", memories, statsError: false, lastHandoff: null });

/** Manual clock plus a fetch whose promises the test resolves by hand. */
function setup() {
	let clock = 1_000_000;
	const pending: Array<{ cwd: string | undefined; resolve(s: EngramSnapshot): void; reject(e: unknown): void }> = [];
	const provider = createEngramProvider({
		now: () => clock,
		fetchSnapshot: (cwd) => new Promise((resolve, reject) => pending.push({ cwd, resolve, reject })),
	});
	let notified = 0;
	provider.watch?.(() => notified++);
	const flush = () => new Promise((r) => setImmediate(r));
	return {
		provider,
		pending,
		flush,
		advance: (ms: number) => (clock += ms),
		notified: () => notified,
		emit: (type: string, cwd = "/proj") => provider.update?.({ type }, { cwd }),
	};
}

test("S1: no card before session_start", () => {
	assert.equal(setup().provider.card(), undefined);
});

test("S1: session_start shows Checking at once, fetches for ctx.cwd, then shows the result and notifies", async () => {
	const t = setup();
	t.emit("session_start", "/work/repo");
	assert.equal(t.provider.card()?.subtitle, "Checking");
	assert.deepEqual(t.pending.map((p) => p.cwd), ["/work/repo"]);
	t.pending[0].resolve(online(5));
	await t.flush();
	assert.equal(t.provider.card()?.body[0], "Memories: 5");
	assert.equal(t.notified(), 1);
});

test("S1: turn_end refreshes at most once per interval and never overlaps an in-flight fetch", async () => {
	const t = setup();
	t.emit("session_start");
	t.advance(ENGRAM_MIN_REFRESH_MS);
	t.emit("turn_end");
	assert.equal(t.pending.length, 1, "still in flight: no second request");
	t.pending[0].resolve(online(1));
	await t.flush();
	t.advance(ENGRAM_MIN_REFRESH_MS - 1);
	t.emit("turn_end");
	assert.equal(t.pending.length, 1, "inside the interval: no request");
	t.advance(1);
	t.emit("turn_end");
	t.emit("message_end");
	t.emit("session_compact");
	assert.equal(t.pending.length, 2, "interval elapsed: exactly one request");
	t.pending[1].resolve(online(2));
	await t.flush();
	assert.equal(t.provider.card()?.body[0], "Memories: 2");
});

test("S1: a rejected fetch shows the daemon as offline", async () => {
	const t = setup();
	t.emit("session_start");
	t.pending[0].reject(new Error("boom"));
	await t.flush();
	assert.equal(t.provider.card()?.subtitle, "Offline");
	assert.equal(t.notified(), 1);
});

test("S1: a result from before a newer session_start is discarded", async () => {
	const t = setup();
	t.emit("session_start", "/old");
	t.emit("session_start", "/new");
	assert.deepEqual(t.pending.map((p) => p.cwd), ["/old", "/new"]);
	t.pending[1].resolve(online(2));
	await t.flush();
	t.pending[0].resolve(online(99));
	await t.flush();
	assert.equal(t.provider.card()?.body[0], "Memories: 2");
	assert.equal(t.notified(), 1, "the stale result does not trigger a render");
});

test("a throwing watcher does not stop the others", async () => {
	const t = setup();
	let second = 0;
	t.provider.watch?.(() => {
		throw new Error("bad listener");
	});
	t.provider.watch?.(() => second++);
	t.emit("session_start");
	t.pending[0].resolve(online(1));
	await t.flush();
	assert.equal(second, 1);
	assert.equal(t.notified(), 1);
});
