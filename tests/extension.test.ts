import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHudCards, type HudCardsDeps } from "../extensions/hud-cards.ts";
import type { CardProvider } from "../lib/host.ts";
import { LAYOUT_FILE, railPatchStatus, type PatchReport } from "../lib/patch.ts";

const theme = { fg: (_role: string, text: string) => text };
const provider = (key: string): CardProvider => ({ key, card: () => ({ key, title: key.toUpperCase(), tone: "info", body: ["row"] }) });
const report = (status: PatchReport["status"], extra: Partial<PatchReport> = {}): PatchReport => ({ status, changed: false, version: "4.8.0", file: "/gp/lib/x.ts", ...extra });

type Handler = (event: unknown, ctx: unknown) => unknown;
type Factory = (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[]; dispose?(): void };

function setup(overrides: Partial<HudCardsDeps>) {
	const sidebarCalls: string[] = [];
	const sidebarPart = (_tui: unknown, key: string, bottom: { render(w: number): string[] }) => (sidebarCalls.push(key), { ...bottom, invalidate() {} });
	const deps: HudCardsDeps = {
		providers: [provider("hud-ctx"), provider("hud-engram")],
		locateRoot: () => "/gp",
		patchStatus: () => report("patched"),
		loadRenderCard: async () => undefined,
		loadSidebarPart: async () => sidebarPart as never,
		...overrides,
	};
	const handlers = new Map<string, Handler[]>();
	createHudCards(deps)({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) } as never);
	const notices: Array<[string, unknown]> = [];
	const widgets: Array<{ key: string; factory: Factory; options: unknown }> = [];
	const ctx = (hasUI = true) => ({
		hasUI,
		ui: {
			notify: (message: string, level?: string) => notices.push([message, level]),
			setWidget: (key: string, factory: Factory, options: unknown) => widgets.push({ key, factory, options }),
		},
	});
	const start = async (c = ctx()) => {
		for (const handler of handlers.get("session_start") ?? []) await handler({}, c);
	};
	return { start, ctx, notices, widgets, sidebarCalls };
}

test("S4: unpatched uses the plain belowEditor widget, never sidebarPart, and notifies once across two session starts", async () => {
	const t = setup({ patchStatus: () => report("unpatched") });
	await t.start();
	await t.start();
	assert.equal(t.widgets.length, 2);
	assert.deepEqual(t.widgets.map((w) => [w.key, w.options]), [["gentle-hud-cards", { placement: "belowEditor" }], ["gentle-hud-cards", { placement: "belowEditor" }]]);
	const component = t.widgets[0].factory({ requestRender() {} }, theme);
	assert.ok(component.render(40).length > 0, "the stacked cards render");
	assert.deepEqual(t.sidebarCalls, []);
	assert.equal(t.notices.length, 1);
	assert.match(t.notices[0][0], /not patched.*below the editor/s);
	assert.equal(t.notices[0][1], "warning");
});

test("S2: patched with sidebarPart registers one hud-* rail part per provider and does not notify", async () => {
	const t = setup({});
	await t.start();
	await t.start();
	t.widgets[0].factory({ requestRender() {} }, theme);
	assert.deepEqual(t.sidebarCalls, ["hud-ctx", "hud-engram"]);
	assert.ok(t.sidebarCalls.every((key) => key.startsWith("hud-")));
	assert.deepEqual(t.notices, []);
});

test("R3-003: patched but sidebarPart not loaded falls back below the editor with an accurate notice, once", async () => {
	const t = setup({ loadSidebarPart: async () => undefined });
	await t.start();
	await t.start();
	assert.equal(t.widgets.length, 2);
	assert.deepEqual(t.widgets[0].options, { placement: "belowEditor" });
	t.widgets[0].factory({ requestRender() {} }, theme);
	assert.deepEqual(t.sidebarCalls, []);
	assert.deepEqual(t.notices, [["gentle-hud-cards: the rail patch is applied, but gentle-pi 4.8.0's sidebar module could not be loaded, so the HUD cards render below the editor.", "warning"]]);
	assert.doesNotMatch(t.notices[0][0], /changed its sidebar layout/);
});

test("R3-002: an unreadable layout falls back below the editor with a notice that carries the error code", async () => {
	const t = setup({ patchStatus: () => report("unreadable", { code: "EACCES" }) });
	await t.start();
	assert.deepEqual(t.widgets.map((w) => w.options), [{ placement: "belowEditor" }]);
	assert.equal(t.notices.length, 1);
	assert.match(t.notices[0][0], /EACCES.*below the editor/s);
});

test("R3-002: the real patch status on a directory at the layout path does not throw out of the factory", async () => {
	const root = mkdtempSync(join(tmpdir(), "hud-ext-"));
	try {
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "4.8.0" }));
		mkdirSync(join(root, LAYOUT_FILE));
		const t = setup({ locateRoot: () => root, patchStatus: railPatchStatus });
		await t.start();
		assert.equal(t.widgets.length, 1);
		assert.match(t.notices[0][0], /EISDIR.*below the editor/s);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("R3-004: no-layout and missing each notify once and fall back below the editor", async () => {
	for (const [status, pattern] of [["no-layout", /lib\/shell-sidebar-layout\.ts.*below the editor/s], ["missing", /not found.*below the editor/s]] as const) {
		const t = setup({ patchStatus: () => report(status) });
		await t.start();
		assert.equal(t.widgets.length, 1);
		assert.equal(t.notices.length, 1);
		assert.match(t.notices[0][0], pattern);
	}
});

test("zero providers: no widget and no notice; hasUI false: nothing at all", async () => {
	const none = setup({ providers: [], patchStatus: () => report("unpatched") });
	await none.start();
	assert.deepEqual([none.widgets.length, none.notices.length], [0, 0]);
	const headless = setup({ patchStatus: () => report("unpatched") });
	await headless.start(headless.ctx(false));
	assert.deepEqual([headless.widgets.length, headless.notices.length, headless.sidebarCalls.length], [0, 0, 0]);
});

test("verifier: a provider without the hud- prefix is skipped by the extension", async () => {
	const t = setup({ providers: [provider("agents"), provider("hud-ok")] });
	await t.start();
	t.widgets[0].factory({ requestRender() {} }, theme);
	assert.deepEqual(t.sidebarCalls, ["hud-ok"]);
	const only = setup({ providers: [provider("todo")], patchStatus: () => report("unpatched") });
	await only.start();
	assert.deepEqual([only.widgets.length, only.notices.length], [0, 0], "no valid provider is the zero-provider case");
});

test("T5: a provider's watch() change requests a render once the widget is mounted, and is ignored before it", async () => {
	let listener: (() => void) | undefined;
	const watched: CardProvider = { ...provider("hud-engram"), watch: (fn) => (listener = fn) };
	const t = setup({ providers: [watched], patchStatus: () => report("unpatched") });
	assert.ok(listener, "the extension subscribes at load");
	assert.doesNotThrow(() => listener?.(), "a change before the widget exists is a no-op");
	await t.start();
	let renders = 0;
	t.widgets[0].factory({ requestRender: () => renders++ }, theme);
	listener?.();
	assert.equal(renders, 1);
});
