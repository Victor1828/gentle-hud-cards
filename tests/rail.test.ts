import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardProvider } from "../lib/host.ts";
import { createRailPart, mountRail, railNotice, sidebarLoadNotice } from "../lib/rail.ts";

const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
const plain = (line: string) => line.replace(/<\/?[a-zA-Z]+>/g, "");

test("a rail part renders the rail header row, then indented, width-bounded body rows", () => {
	const provider: CardProvider = { key: "hud-ctx", card: () => ({ key: "hud-ctx", title: "CONTEXT", subtitle: "42%", tone: "info", body: ["short", "a body row that is far too long"] }) };
	const lines = createRailPart(provider, theme).render(20);
	assert.deepEqual(lines.map(plain), ["▾ CONTEXT  42%", "  short", "  a body row that i…"]);
});

const boldTheme = { fg: theme.fg, bold: (text: string) => `[${text}]` };

test("S11: the header mirrors the native one: muted glyph, bold `text` title, muted subtitle", () => {
	const provider: CardProvider = { key: "hud-t", card: () => ({ key: "hud-t", title: "tools", subtitle: "5", tone: "info", body: ["x"] }) };
	assert.deepEqual(createRailPart(provider, boldTheme).render(20), ["<muted>▾</muted> <text>[TOOLS]</text>  <muted>5</muted>", "  x"]);
	assert.equal(createRailPart(provider, theme).render(20)[0], "<muted>▾</muted> <text>TOOLS</text>  <muted>5</muted>", "a theme without bold still renders");
});

test("S11: a card that keeps its tone color paints glyph and bold title with it", () => {
	const keep = (tone: "info" | "warning") => ({ key: "hud-c", title: "CONTEXT+", subtitle: "Fresh", tone, keepToneColor: true, body: [] });
	assert.equal(createRailPart({ key: "hud-c", card: () => keep("info") }, boldTheme).render(30)[0], "<accent>▾</accent> <accent>[CONTEXT+]</accent>  <muted>Fresh</muted>");
	assert.equal(createRailPart({ key: "hud-c", card: () => keep("warning") }, boldTheme).render(30)[0], "<warning>▾</warning> <warning>[CONTEXT+]</warning>  <muted>Fresh</muted>");
});

const mouse = (type: string, y: number, button = "left") => ({ type, button, x: 1, y, screenX: 1, screenY: y, width: 30, height: 3, shift: false, alt: false, ctrl: false });
function clickable(hooks: { requestRender?(): void; setHover?(owner: object, clear: () => void): void } = {}) {
	const provider: CardProvider = { key: "hud-k", card: () => ({ key: "hud-k", title: "K", subtitle: "1", tone: "info", body: ["a", "b"] }) };
	return createRailPart(provider, theme, hooks);
}

test("S10: a left click on the header row collapses to the ▸ header, a second click expands; state is not persisted", () => {
	let renders = 0;
	const part = clickable({ requestRender: () => renders++ });
	const open = part.digest();
	assert.deepEqual(part.handleMouse(mouse("click", 0)), { handled: true, render: true });
	assert.equal(renders, 1);
	assert.deepEqual(part.render(20).map(plain), ["▸ K  1"]);
	assert.notEqual(part.digest(), open);
	assert.deepEqual(part.handleMouse(mouse("click", 0)), { handled: true, render: true });
	assert.deepEqual(part.render(20).map(plain), ["▾ K  1", "  a", "  b"]);
	assert.equal(part.digest(), open);
	part.handleMouse(mouse("click", 0));
	assert.equal(clickable().render(20).length, 3, "a fresh part (after /reload) is open");
});

test("S10: other clicks are ignored: body rows, right button, press, wheel", () => {
	const part = clickable();
	for (const event of [mouse("click", 1), mouse("click", 2), mouse("click", 0, "right"), mouse("press", 0), mouse("wheel", 0, "none")]) assert.equal(part.handleMouse(event), undefined);
	assert.equal(part.render(20).length, 3);
});

test("S11: hovering the header paints the title with `warning` like native, and leaving clears it", () => {
	let renders = 0;
	let owner: { owner: object; clear: () => void } | undefined;
	const part = clickable({ requestRender: () => renders++, setHover: (o, clear) => (owner = { owner: o, clear }) });
	const idle = part.digest();
	assert.deepEqual(part.handleMouse(mouse("move", 0, "none")), { handled: true, render: true });
	assert.ok(part.render(20)[0].includes("<warning>K</warning>"));
	assert.ok(part.render(20)[0].startsWith("<warning>▾</warning>"));
	assert.notEqual(part.digest(), idle);
	assert.ok(owner, "the part registers as the sidebar hover owner");
	assert.equal(part.handleMouse(mouse("move", 1, "none"))?.handled, true, "moving to a body row clears hover");
	assert.ok(part.render(20)[0].includes("<text>K</text>"));
	part.handleMouse(mouse("move", 0, "none"));
	owner!.clear();
	assert.ok(part.render(20)[0].includes("<text>K</text>"), "the layout clearing the owner clears hover");
	assert.ok(renders >= 3);
	assert.equal(clickable().handleMouse(mouse("move", 2, "none")), undefined, "a move off the header while idle is not consumed");
});

test("R3-001: the header never exceeds the width: title truncates first, the subtitle stays only if it fits", () => {
	const card = { key: "hud-l", title: "A VERY LONG CARD TITLE", subtitle: "42%", tone: "info" as const, body: [] };
	const header = (width: number) => plain(createRailPart({ key: "hud-l", card: () => card }, theme).render(width)[0]);
	assert.equal(header(20), "▾ A VERY LONG CARD …");
	assert.equal(header(10), "▾ A VERY …");
	for (const width of [30, 24, 23, 22, 20, 12, 10, 6, 3]) assert.ok([...header(width)].length <= Math.max(3, width), `width ${width}: ${header(width)}`);
	const short = { ...card, title: "CTX", subtitle: "a long subtitle here" };
	const shortHeader = (width: number) => plain(createRailPart({ key: "hud-l", card: () => short }, theme).render(width)[0]);
	assert.equal(shortHeader(40), "▾ CTX  a long subtitle here");
	assert.equal(shortHeader(16), "▾ CTX  a long s…");
	assert.equal(shortHeader(8), "▾ CTX");
});

test("a rail part renders nothing without a card", () => {
	const warn: CardProvider = { key: "hud-w", card: () => ({ key: "hud-w", title: "W", tone: "warning", body: [] }) };
	assert.deepEqual(createRailPart(warn, theme).render(20), ["<muted>▾</muted> <text>W</text>"], "native title style: tone only colors keepToneColor cards");
	assert.deepEqual(createRailPart({ key: "hud-n", card: () => undefined }, theme).render(20), []);
	assert.deepEqual(createRailPart({ key: "hud-x", card: () => { throw new Error("x"); } }, theme).render(20), []);
});

test("the digest changes exactly when the card content changes", () => {
	let body = ["a"];
	const part = createRailPart({ key: "hud-d", card: () => ({ key: "hud-d", title: "D", tone: "info", body }) }, theme);
	const first = part.digest();
	assert.equal(part.digest(), first);
	body = ["b"];
	assert.notEqual(part.digest(), first);
});

test("mountRail hands each part the tui render request and the native hover setter", () => {
	let renders = 0;
	const hovers: unknown[] = [];
	let railPart: { handleMouse?(e: unknown): unknown } | undefined;
	const tui = { requestRender: () => renders++ };
	const sidebarPart = (_t: unknown, _k: string, bottom: object, rail: object) => ((railPart = rail), bottom as never);
	const provider: CardProvider = { key: "hud-m", card: () => ({ key: "hud-m", title: "M", tone: "info", body: ["x"] }) };
	mountRail(tui, [provider], theme, { render: () => [], invalidate() {} }, sidebarPart, (t, owner) => hovers.push([t, typeof owner]));
	railPart!.handleMouse!(mouse("move", 0, "none"));
	railPart!.handleMouse!(mouse("click", 0));
	assert.deepEqual(hovers, [[tui, "object"]]);
	assert.ok(renders >= 2);
});

test("mountRail registers one hud-* part per provider and puts the stacked cards on the first", () => {
	const registered: Array<{ key: string; bottom: { render(w: number): string[] } }> = [];
	const disposed: string[] = [];
	const sidebarPart = (_tui: unknown, key: string, bottom: { render(w: number): string[]; dispose?(): void }) => {
		registered.push({ key, bottom });
		return { ...bottom, dispose: () => disposed.push(key) };
	};
	const providers: CardProvider[] = ["hud-a", "hud-b"].map((key) => ({ key, card: () => ({ key, title: key, tone: "info" as const, body: [] }) }));
	const bottom = { render: () => ["stacked"], invalidate() {} };
	const mounted = mountRail({}, providers, theme, bottom, sidebarPart);
	assert.deepEqual(registered.map((r) => r.key), ["hud-a", "hud-b"]);
	assert.deepEqual(mounted.render(30), ["stacked"]);
	assert.deepEqual(registered[1].bottom.render(30), [], "only the first part paints the bottom widget");
	mounted.dispose();
	assert.deepEqual(disposed, ["hud-a", "hud-b"]);
});

test("verifier: mountRail skips providers whose key lacks the hud- prefix", () => {
	const registered: string[] = [];
	const sidebarPart = (_tui: unknown, key: string, bottom: { render(w: number): string[] }) => (registered.push(key), { ...bottom, invalidate() {} });
	const make = (key: string): CardProvider => ({ key, card: () => ({ key, title: key, tone: "info", body: [] }) });
	const seen: string[] = [];
	const bottom = { render: () => ["stacked"], invalidate() {} };
	mountRail({}, [make("agents"), make("hud-ok"), make("todo")], theme, bottom, (tui, key, b, rail) => (seen.push(key + ":" + b.render(10).length), sidebarPart(tui, key, b)));
	assert.deepEqual(registered, ["hud-ok"], "native section keys cannot be hijacked");
	assert.deepEqual(seen, ["hud-ok:1"], "the first accepted part carries the bottom widget");
});

test("railNotice explains every non-patched status and stays silent when patched", () => {
	assert.equal(railNotice({ status: "patched", version: "4.8.0" }), undefined);
	assert.match(railNotice({ status: "unpatched", version: "4.8.0" })!, /gentle-pi 4\.8\.0.*not patched.*npm run rail:patch.*\/reload/s);
	assert.match(railNotice({ status: "unknown", version: "4.9.0" })!, /gentle-pi 4\.9\.0.*changed.*not applied/s);
	assert.match(railNotice({ status: "missing" })!, /gentle-pi.*not found/);
	assert.match(railNotice({ status: "no-layout", version: "4.1.0" })!, /gentle-pi 4\.1\.0.*lib\/shell-sidebar-layout\.ts.*not supported/s);
	assert.match(railNotice({ status: "unreadable", version: "4.8.0", code: "EACCES" })!, /EACCES/);
	assert.equal(sidebarLoadNotice("4.8.0"), "gentle-hud-cards: the rail patch is applied, but gentle-pi 4.8.0's sidebar module could not be loaded, so the HUD cards render below the editor.");
	for (const status of ["unpatched", "unknown", "missing", "no-layout", "unreadable"] as const) assert.match(railNotice({ status, version: "4.8.0" })!, /below the editor/);
});
