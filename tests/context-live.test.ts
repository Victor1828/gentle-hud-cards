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
	})({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), registerCommand() {} } as never);
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

test("T11b: session_shutdown changes nothing and never reads the stale context", () => {
	const provider = createContextProvider({ readReserve: () => 16_384 });
	const ctx = { getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000 }), sessionManager: { getBranch: () => [] } };
	provider.update?.({ type: "session_start" }, ctx);
	const before = JSON.stringify(provider.card());
	provider.update?.({ type: "session_shutdown" }, { getContextUsage: () => { throw new Error("stale ctx"); }, sessionManager: { getBranch: () => { throw new Error("stale ctx"); } } });
	assert.equal(JSON.stringify(provider.card()), before);
});

// S14: agent advice held by the provider.
const adviceCtx = (branch: unknown[] = []) => ({ getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000 }), sessionManager: { getBranch: () => branch } });
const adviceEnd = (details: unknown, extra: object = {}) => ({ type: "tool_execution_end", toolCallId: "t", toolName: "context_advice", isError: false, result: { content: [], details }, ...extra });
const started = (branch: unknown[] = []) => {
	const provider = createContextProvider({ readReserve: () => 16_384 });
	provider.update?.({ type: "session_start" }, adviceCtx(branch));
	return provider;
};
const rows = (provider: CardProvider) => provider.card()?.body.slice(4);
const toolResult = (details: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "context_advice", isError: false, details } });

test("S14: a successful context_advice tool_execution_end adds the agent rows and requests one render", () => {
	const provider = started();
	let renders = 0;
	provider.watch?.(() => renders++);
	assert.deepEqual(rows(provider), []);
	provider.update?.(adviceEnd({ action: "new_session", reason: "topic switched to MCP" }), adviceCtx());
	assert.deepEqual(rows(provider), ["✦ Agent: new session", "  topic switched to MCP"]);
	assert.deepEqual(provider.card()?.body.slice(0, 4), ["45% · 90k / 200k", "Compact in 93.6k", "Compactions: 0", "→ /compact at next break"]);
	assert.equal(renders, 1);
});

test("S14: keep clears the advice and requests a render; compact replaces new_session", () => {
	const provider = started();
	let renders = 0;
	provider.watch?.(() => renders++);
	provider.update?.(adviceEnd({ action: "new_session", reason: "a" }), adviceCtx());
	provider.update?.(adviceEnd({ action: "compact", reason: "b" }), adviceCtx());
	assert.deepEqual(rows(provider), ["✦ Agent: /compact", "  b"]);
	provider.update?.(adviceEnd({ action: "keep", reason: "c" }), adviceCtx());
	assert.deepEqual(rows(provider), []);
	assert.equal(provider.card()?.glyphRoles, undefined);
	assert.equal(renders, 3);
});

test("S14: failed calls, other tools and malformed details change nothing and request no render", () => {
	const provider = started();
	let renders = 0;
	provider.watch?.(() => renders++);
	provider.update?.(adviceEnd({ action: "new_session", reason: "kept" }), adviceCtx());
	renders = 0;
	for (const event of [adviceEnd({ action: "keep", reason: "" }, { isError: true }), adviceEnd({ action: "keep", reason: "" }, { toolName: "read" }), adviceEnd("garbage"), adviceEnd(undefined), adviceEnd({ action: "bogus" }), { type: "tool_execution_end", toolName: "context_advice", isError: false }]) {
		provider.update?.(event, adviceCtx());
		assert.deepEqual(rows(provider), ["✦ Agent: new session", "  kept"]);
	}
	assert.equal(renders, 0);
});

test("S14: a throwing watch listener never breaks the update", () => {
	const provider = started();
	provider.watch?.(() => {
		throw new Error("boom");
	});
	assert.doesNotThrow(() => provider.update?.(adviceEnd({ action: "compact", reason: "r" }), adviceCtx()));
	assert.deepEqual(rows(provider), ["✦ Agent: /compact", "  r"]);
});

test("S14: session_start rebuilds the latest advice after the latest compaction from the branch", () => {
	const a = { action: "compact", reason: "one" };
	const b = { action: "new_session", reason: "two" };
	assert.deepEqual(rows(started([toolResult(a), toolResult(b)])), ["✦ Agent: new session", "  two"]);
	assert.deepEqual(rows(started([toolResult(b), { type: "compaction" }, toolResult(a)])), ["✦ Agent: /compact", "  one"]);
	assert.deepEqual(rows(started([toolResult(b), { type: "compaction" }])), [], "advice before a compaction is ignored");
	assert.deepEqual(rows(started([toolResult(b), toolResult({ action: "keep", reason: "" })])), []);
	assert.deepEqual(rows(started([toolResult("junk"), null, { type: "message" }])), []);
});

test("S14: a new session_start replaces earlier advice (and an unreadable branch clears it)", () => {
	const provider = started([toolResult({ action: "new_session", reason: "x" })]);
	assert.equal(rows(provider)?.length, 2);
	provider.update?.({ type: "session_start" }, { getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000 }), sessionManager: { getBranch: () => { throw new Error("no"); } } });
	assert.deepEqual(rows(provider), []);
});

test("S14: session_compact clears the advice (it judged the old context)", () => {
	const provider = started();
	provider.update?.(adviceEnd({ action: "new_session", reason: "x" }), adviceCtx());
	provider.update?.({ type: "session_compact" }, adviceCtx([{ type: "compaction" }]));
	assert.equal(provider.card()?.body.includes("✦ Agent: new session"), false);
	assert.deepEqual(provider.card()?.body.slice(2, 3), ["Compactions: 1"]);
});

test("S14: advice before session_start is ignored; no advice leaves the card as before", () => {
	const provider = createContextProvider({ readReserve: () => 16_384 });
	provider.update?.(adviceEnd({ action: "new_session", reason: "x" }), adviceCtx());
	assert.equal(provider.card(), undefined);
	assert.deepEqual(started().card()?.body, ["45% · 90k / 200k", "Compact in 93.6k", "Compactions: 0", "→ /compact at next break"]);
});
