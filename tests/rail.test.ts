import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardProvider } from "../lib/host.ts";
import { createRailPart, mountRail, railNotice } from "../lib/rail.ts";

const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
const plain = (line: string) => line.replace(/<\/?[a-zA-Z]+>/g, "");

test("a rail part renders the rail header row, then indented, width-bounded body rows", () => {
	const provider: CardProvider = { key: "hud-ctx", card: () => ({ key: "hud-ctx", title: "CONTEXT", subtitle: "42%", tone: "info", body: ["short", "a body row that is far too long"] }) };
	const lines = createRailPart(provider, theme).render(20);
	assert.deepEqual(lines.map(plain), ["▾ CONTEXT  42%", "  short", "  a body row that i…"]);
	assert.ok(lines[0].startsWith("<accent>▾</accent> "), "INFO header uses the accent role");
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

test("railNotice explains every non-patched status and stays silent when patched", () => {
	assert.equal(railNotice({ status: "patched", version: "4.8.0" }), undefined);
	assert.match(railNotice({ status: "unpatched", version: "4.8.0" })!, /gentle-pi 4\.8\.0.*not patched.*npm run rail:patch.*\/reload/s);
	assert.match(railNotice({ status: "unknown", version: "4.9.0" })!, /gentle-pi 4\.9\.0.*changed.*not applied/s);
	assert.match(railNotice({ status: "missing" })!, /gentle-pi.*not found/);
	for (const status of ["unpatched", "unknown", "missing"] as const) assert.match(railNotice({ status, version: "4.8.0" })!, /below the editor/);
});
