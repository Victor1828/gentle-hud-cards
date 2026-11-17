import assert from "node:assert/strict";
import { test } from "node:test";
import { createHudCards } from "../extensions/hud-cards.ts";
import { createContextProvider } from "../lib/cards/context-live.ts";
import type { CardProvider } from "../lib/host.ts";
import type { PatchReport } from "../lib/patch.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const theme = { fg: (_role: string, text: string) => text };
const unpatched: PatchReport = { status: "unpatched", changed: false, version: "4.8.0", file: "/gp/x.ts" };

interface FakeState {
	tokens: number | null;
	contextWindow?: number;
	branch?: unknown[];
	hasUI?: boolean;
}

function setup(extraProviders: CardProvider[] = [], reserve = 16_384) {
	const state: FakeState = { tokens: null, contextWindow: 200_000, branch: [] };
	const ctx = {
		get hasUI() {
			return state.hasUI ?? true;
		},
		cwd: "/proj",
		model: { provider: "p", id: "m" },
		ui: { notify() {}, setWidget: (_k: string, factory: unknown, _o: unknown) => widgets.push(factory as never) },
		sessionManager: { getBranch: () => state.branch },
		getContextUsage: () => (state.contextWindow === undefined ? undefined : { tokens: state.tokens, contextWindow: state.contextWindow, percent: null }),
	};
	const widgets: Array<(tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[] }> = [];
	const provider = createContextProvider({ readReserve: () => reserve });
	const handlers = new Map<string, Handler[]>();
	createHudCards({
		providers: [...extraProviders, provider],
		locateRoot: () => undefined,
		patchStatus: () => unpatched,
		loadRenderCard: async () => undefined,
		loadSidebarPart: async () => undefined,
	})({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) } as never);
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	return { provider, state, emit, widgets };
}

test("S1/S8: no card before the first session_start", () => {
	assert.equal(setup().provider.card(), undefined);
});

test("S1/S8: the card reflects usage after session_start + turn_end", async () => {
	const t = setup();
	t.state.tokens = 100_000;
	await t.emit("session_start");
	assert.deepEqual(t.provider.card()?.body.slice(0, 3), ["50% · 100k / 200k", "Compact in 83.6k", "Compactions: 0"]);
	t.state.tokens = 100_000;
	await t.emit("turn_end");
	t.state.tokens = 130_000;
	await t.emit("turn_end");
	const card = t.provider.card();
	// 30k of growth per turn leaves 1 turn before auto-compact: Saturated (S8).
	assert.deepEqual([card?.subtitle, card?.tone], ["Saturated", "error"]);
	assert.deepEqual(card?.body, ["65% · 130k / 200k", "Compact in 53.6k · ~1 turn", "Compactions: 0", "→ /compact now"]);
});

test("S8: avgTurnGrowth is the mean positive delta of the last 5 turn_end samples; drops are ignored", async () => {
	const t = setup();
	await t.emit("session_start");
	// samples 10k, 20k, 30k, 5k (compaction drop), 25k: positive deltas 10k, 10k, 20k -> mean 13.33k
	for (const tokens of [10_000, 20_000, 30_000, 5_000, 25_000]) {
		t.state.tokens = tokens;
		await t.emit("turn_end");
	}
	// left = 183_616 - 25_000 = 158_616; / 13_333.33 = 11.9 -> 11
	assert.equal(t.provider.card()?.body[1], "Compact in 159k · ~11 turns");
	// a sixth sample pushes the oldest out: window 20k,30k,5k,25k,35k -> deltas 10k,20k,10k (drop ignored) -> 13.33k again
	t.state.tokens = 35_000;
	await t.emit("turn_end");
	assert.equal(t.provider.card()?.body[1], "Compact in 149k · ~11 turns");
});

test("S8: unknown tokens (after a compaction, before the next response) render the unknown card and do not crash", async () => {
	const t = setup();
	await t.emit("session_start");
	assert.equal(t.provider.card()?.subtitle, "Unknown");
	t.state.contextWindow = undefined;
	await t.emit("message_end");
	assert.equal(t.provider.card()?.subtitle, "Unknown");
});

test("S8: session_compact counts compactions; branch entries seed the count and are never double counted", async () => {
	const t = setup();
	t.state.branch = [{ type: "message" }, { type: "compaction" }];
	t.state.tokens = 130_000;
	await t.emit("session_start");
	assert.equal(t.provider.card()?.body[2], "Compactions: 1");
	assert.equal(t.provider.card()?.body[3], "→ Start a new session");
	await t.emit("session_compact"); // branch not yet updated: counted once
	assert.equal(t.provider.card()?.body[2], "Compactions: 2");
	t.state.branch = [{ type: "compaction" }, { type: "compaction" }];
	await t.emit("turn_end");
	assert.equal(t.provider.card()?.body[2], "Compactions: 2");
	t.state.branch = [{ type: "compaction" }, { type: "compaction" }, { type: "compaction" }];
	await t.emit("session_compact"); // branch already updated
	assert.equal(t.provider.card()?.body[2], "Compactions: 3");
});

test("S8: a session_compact without a readable branch still counts", async () => {
	const t = setup();
	t.state.branch = undefined;
	t.state.tokens = 1_000;
	await t.emit("session_start");
	await t.emit("session_compact");
	await t.emit("session_compact");
	assert.equal(t.provider.card()?.body[2], "Compactions: 2");
});

test("S8: a new session_start resets compactions and growth samples", async () => {
	const t = setup();
	await t.emit("session_start");
	for (const tokens of [10_000, 20_000]) {
		t.state.tokens = tokens;
		await t.emit("turn_end");
	}
	await t.emit("session_compact");
	assert.equal(t.provider.card()?.body[2], "Compactions: 1");
	t.state.tokens = 5_000;
	await t.emit("session_start");
	assert.deepEqual(t.provider.card()?.body, ["2% · 5k / 200k", "Compact in 179k", "Compactions: 0", "→ Keep going"]);
});

test("S8: the reserve is read at session_start and drives autoCompactAt", async () => {
	const t = setup([], 100_000);
	t.state.tokens = 10_000;
	await t.emit("session_start");
	assert.equal(t.provider.card()?.body[1], "Compact in 90k");
});

test("S3: the provider renders in the stacked widget, and a throwing update never breaks the other providers", async () => {
	const seen: string[] = [];
	const bad: CardProvider = { key: "hud-bad", card: () => undefined, update: () => { throw new Error("boom"); } };
	const spy: CardProvider = { key: "hud-spy", card: () => undefined, update: (event) => void seen.push(event.type) };
	const t = setup([bad, spy]);
	t.state.tokens = 100_000;
	await t.emit("session_start");
	await t.emit("turn_end");
	assert.deepEqual(seen, ["session_start", "turn_end"]);
	assert.equal(t.provider.card()?.body[0], "50% · 100k / 200k");
	const lines = t.widgets[0]({ requestRender() {} }, theme).render(60).join("\n");
	assert.match(lines, /CONTEXT\+/);
	assert.match(lines, /50% · 100k \/ 200k/);
});

test("S8: events that reach update still work when hasUI is false (state is kept for a later UI)", async () => {
	const t = setup();
	t.state.hasUI = false;
	t.state.tokens = 100_000;
	await t.emit("session_start");
	assert.equal(t.provider.card()?.body[0], "50% · 100k / 200k");
});
