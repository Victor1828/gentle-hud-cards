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
	assert.ok(lines[0].startsWith("<accent>▾</accent> "), "INFO header uses the accent role");
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

test("a rail part takes its tone role for non-INFO cards and renders nothing without a card", () => {
	const warn: CardProvider = { key: "hud-w", card: () => ({ key: "hud-w", title: "W", tone: "warning", body: [] }) };
	assert.deepEqual(createRailPart(warn, theme).render(20), ["<warning>▾</warning> <warning>W</warning>"]);
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
