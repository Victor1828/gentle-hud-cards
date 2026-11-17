import assert from "node:assert/strict";
import { test } from "node:test";
import { createHudCards, defaultProviders, type HudCardsDeps } from "../extensions/hud-cards.ts";
import type { CardProvider } from "../lib/host.ts";
import type { PatchReport } from "../lib/patch.ts";
import type { VisibilityStore } from "../lib/visibility.ts";

const theme = { fg: (_role: string, text: string) => text };
const provider = (id: string): CardProvider => ({ key: id, card: () => ({ key: id, title: id.toUpperCase(), tone: "info", body: ["row"] }) });
const patched: PatchReport = { status: "patched", changed: false, version: "4.8.0", file: "/gp/lib/x.ts" };

type Handler = (event: unknown, ctx: unknown) => unknown;
type Factory = (tui: unknown, theme: unknown) => { render(width: number): string[] };
type Command = { description?: string; handler(args: string, ctx: unknown): Promise<void> };
type Part = { render(w: number): string[]; handleMouse?(event: unknown): unknown };

function memoryStore(initial: { hidden: string[]; error?: string } = { hidden: [] }, failWrites = false) {
	let state = { ...initial };
	const writes: string[][] = [];
	const store: VisibilityStore = {
		read: () => ({ ...state }),
		write: (hidden) => {
			if (failWrites) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			writes.push([...hidden]);
			state = { hidden: [...hidden] };
		},
	};
	return { store, writes };
}

function setup(store: ReturnType<typeof memoryStore>, overrides: Partial<HudCardsDeps> = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const parts = new Map<string, Part>();
	const sidebarPart = (_tui: unknown, id: string, bottom: { render(w: number): string[] }, part: Part) => (parts.set(id, part), { ...bottom, invalidate() {} });
	createHudCards({
		providers: [provider("hud-context"), provider("hud-engram"), provider("hud-mcp"), provider("hud-tools")],
		locateRoot: () => "/gp",
		patchStatus: () => patched,
		loadRenderCard: async () => undefined,
		loadSidebarPart: async () => sidebarPart as never,
		visibility: store.store,
		...overrides,
	})({
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, options: Command) => commands.set(name, options),
	} as never);
	const notices: Array<[string, unknown]> = [];
	const widgets: Factory[] = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const ctx = (script: Array<number | undefined>, hasUI = true) => ({
		hasUI,
		ui: {
			notify: (message: string, level?: string) => notices.push([message, level]),
			setWidget: (_id: string, factory: Factory) => widgets.push(factory),
			select: async (title: string, options: string[]) => {
				selects.push({ title, options: [...options] });
				const next = script.shift();
				return next === undefined ? undefined : options[next];
			},
		},
	});
	const renders = { count: 0 };
	let mounted: ReturnType<Factory> | undefined;
	// Session start, then mount the widget the way Pi does (it also registers the rail parts).
	const start = async () => {
		const c = ctx([]);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, c);
		mounted = widgets[widgets.length - 1]({ requestRender: () => renders.count++ }, theme) as never;
	};
	const hud = (script: Array<number | undefined>, hasUI = true) => commands.get("hud")?.handler("", ctx(script, hasUI));
	const fallback = () => (mounted as { render(w: number): string[] }).render(60).join("\n");
	return { commands, handlers, start, hud, notices, widgets, selects, parts, fallback, renders };
}

test("S12: the extension registers /hud with a description", () => {
	const t = setup(memoryStore());
	assert.match(t.commands.get("hud")?.description ?? "", /show or hide/i);
});

test("S12: with no file all four cards show in the fallback and the rail parts render, with no notice", async () => {
	const t = setup(memoryStore());
	await t.start();
	for (const title of ["HUD-CONTEXT", "HUD-ENGRAM", "HUD-MCP", "HUD-TOOLS"]) assert.match(t.fallback(), new RegExp(title));
	assert.deepEqual([...t.parts.keys()], ["hud-context", "hud-engram", "hud-mcp", "hud-tools"]);
	assert.ok([...t.parts.values()].every((part) => part.render(40).length > 0));
	assert.deepEqual(t.notices, []);
});

test("S12: a hidden card is absent from the fallback widget and renders no rail rows; unknown keys are ignored silently", async () => {
	const t = setup(memoryStore({ hidden: ["hud-mcp", "hud-unknown"] }));
	await t.start();
	assert.doesNotMatch(t.fallback(), /HUD-MCP/);
	for (const title of ["HUD-CONTEXT", "HUD-ENGRAM", "HUD-TOOLS"]) assert.match(t.fallback(), new RegExp(title));
	assert.deepEqual(t.parts.get("hud-mcp")?.render(40), []);
	assert.ok((t.parts.get("hud-tools")?.render(40) ?? []).length > 0);
	assert.deepEqual(t.notices, []);
});

test("S12: a hidden provider still receives update() and watch() stays wired", async () => {
	const seen: string[] = [];
	let listener: (() => void) | undefined;
	const hidden: CardProvider = { ...provider("hud-mcp"), update: (event) => void seen.push(event.type), watch: (fn) => (listener = fn) };
	const t = setup(memoryStore({ hidden: ["hud-mcp"] }), { providers: [hidden] });
	assert.ok(listener, "watch is wired for a hidden card");
	await t.start();
	for (const handler of t.handlers.get("turn_end") ?? []) handler({}, { hasUI: true });
	assert.deepEqual(seen, ["session_start", "turn_end"]);
});

test("S12: /hud lists the four cards in rail order with shown/hidden rows", async () => {
	const t = setup(memoryStore({ hidden: ["hud-mcp"] }));
	await t.start();
	await t.hud([undefined]);
	assert.equal(t.selects.length, 1);
	assert.deepEqual(t.selects[0].options, ["● CONTEXT+  shown", "● ENGRAM  shown", "○ MCP  hidden", "● TOOLS  shown"]);
	assert.match(t.selects[0].title, /HUD cards/);
});

test("S12: choosing a row toggles, saves, re-renders, and reopens the selector with the new state; cancel closes", async () => {
	const m = memoryStore();
	const t = setup(m);
	await t.start();
	await t.hud([2, 2, undefined]);
	assert.equal(t.selects.length, 3);
	assert.equal(t.selects[1].options[2], "○ MCP  hidden");
	assert.equal(t.selects[2].options[2], "● MCP  shown");
	assert.deepEqual(m.writes, [["hud-mcp"], []]);
	assert.equal(t.renders.count, 2);
});

test("S12: hiding through /hud removes the card from the fallback and the rail on the next render; showing brings it back", async () => {
	const t = setup(memoryStore());
	await t.start();
	await t.hud([2, undefined]);
	assert.doesNotMatch(t.fallback(), /HUD-MCP/);
	assert.deepEqual(t.parts.get("hud-mcp")?.render(40), []);
	await t.hud([2, undefined]);
	assert.match(t.fallback(), /HUD-MCP/);
	assert.ok((t.parts.get("hud-mcp")?.render(40) ?? []).length > 0);
});

test("S12: cancelling the first selector saves nothing", async () => {
	const m = memoryStore();
	const t = setup(m);
	await t.start();
	await t.hud([undefined]);
	assert.deepEqual(m.writes, []);
});

test("S12: a save failure notifies an error and leaves the state unchanged", async () => {
	const t = setup(memoryStore({ hidden: [] }, true));
	await t.start();
	await t.hud([2, undefined]);
	assert.equal(t.notices.length, 1);
	assert.equal(t.notices[0][1], "error");
	assert.match(t.notices[0][0], /gentle-hud-cards.*ENOSPC/s);
	assert.equal(t.selects[1].options[2], "● MCP  shown", "the reopened selector still shows MCP");
	assert.match(t.fallback(), /HUD-MCP/);
});

test("S12: /hud without UI does nothing", async () => {
	const m = memoryStore();
	const t = setup(m);
	await t.hud([2], false);
	assert.deepEqual([t.selects.length, t.notices.length, m.writes.length], [0, 0, 0]);
});

test("S12: an invalid file shows every card, warns once across session starts, and is only rewritten by a toggle", async () => {
	const message = "gentle-hud-cards: /x/gentle-hud-cards.json is not valid JSON; showing every card.";
	const m = memoryStore({ hidden: [], error: message });
	const t = setup(m);
	await t.start();
	await t.start();
	assert.deepEqual(t.notices, [[message, "warning"]]);
	assert.match(t.fallback(), /HUD-MCP/);
	assert.deepEqual(m.writes, []);
	await t.hud([2, undefined]);
	assert.deepEqual(m.writes, [["hud-mcp"]]);
});

test("S12: without an injected store nothing touches disk and every card shows", async () => {
	const t = setup(memoryStore(), { visibility: undefined });
	await t.start();
	assert.match(t.fallback(), /HUD-MCP/);
	await t.hud([2, undefined]);
	assert.doesNotMatch(t.fallback(), /HUD-MCP/);
});

test("T9/T10: collapse stays independent of visibility", async () => {
	const t = setup(memoryStore());
	await t.start();
	const part = t.parts.get("hud-mcp");
	part?.handleMouse?.({ type: "click", button: "left", y: 0 });
	assert.equal(part?.render(40).length, 1);
	await t.hud([2, 2, undefined]);
	assert.equal(part?.render(40).length, 1);
});

test("T10: the default provider list keeps the rail order the selector uses", () => {
	assert.deepEqual(defaultProviders.map((entry) => entry.key), ["hud-context", "hud-engram", "hud-mcp", "hud-tools"]);
});
