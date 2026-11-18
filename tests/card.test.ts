import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackRenderCard, renderHudCard, type HudCard, type NativeRenderCard } from "../lib/card.ts";

// Tags every paint with its role so tests can assert which theme role was used.
const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
const plain = (line: string) => line.replace(/<\/?[a-zA-Z]+>/g, "");
const card: HudCard = { key: "hud-test", title: "TEST", tone: "info", body: ["hello"] };

test("fallback paints a rounded frame of the exact width with the INFO roles", () => {
	const lines = fallbackRenderCard(card, theme, 20);
	assert.deepEqual(lines.map(plain), ["╭─ ✿ TEST ─────────╮", "│ hello            │", "╰──────────────────╯"]);
	assert.ok(lines[0].includes("<border>╭─ </border>"), "INFO frame uses the border role");
	assert.ok(lines[0].includes("<accent>✿ TEST</accent>"), "INFO title uses the accent role");
});

test("fallback paints frame and title with the tone role for non-INFO tones", () => {
	const lines = fallbackRenderCard({ ...card, tone: "warning" }, theme, 20);
	assert.ok(lines[0].includes("<warning>╭─ </warning>"));
	assert.ok(lines[0].includes("<warning>✿ TEST</warning>"));
	assert.ok(lines[2].includes("<warning>╰"));
});

test("fallback truncates long body lines and titles to the width", () => {
	const lines = fallbackRenderCard({ ...card, title: "A VERY LONG TITLE", body: ["0123456789012345678901234"] }, theme, 16);
	for (const line of lines) assert.equal([...plain(line)].length, 16, plain(line));
	assert.equal(plain(lines[1]), "│ 01234567890… │");
});

test("fallback renders nothing at widths too narrow for a frame", () => {
	assert.deepEqual(fallbackRenderCard(card, theme, 4), []);
});

test("renderHudCard uses the native renderer with panel chrome when available", () => {
	const calls: unknown[] = [];
	const native: NativeRenderCard = (c, t, w, o) => {
		calls.push({ c, w, o, t });
		return ["native"];
	};
	assert.deepEqual(renderHudCard(card, theme, 30, native), ["native"]);
	assert.deepEqual(calls, [{ c: { title: "TEST", subtitle: undefined, body: ["hello"], tone: "info" }, w: 30, o: { expanded: true, panel: true }, t: theme }]);
});

test("renderHudCard falls back when the native renderer throws or returns garbage", () => {
	const expected = fallbackRenderCard(card, theme, 20);
	assert.deepEqual(renderHudCard(card, theme, 20, () => { throw new Error("boom"); }), expected);
	assert.deepEqual(renderHudCard(card, theme, 20, (() => "nope") as unknown as NativeRenderCard), expected);
	assert.deepEqual(renderHudCard(card, theme, 20, undefined), expected);
});

// ---- S13: a row's glyph can be painted with a theme role, in the fallback and in the native path ----

const painted: HudCard = { key: "hud-test", title: "TEST", tone: "info", body: ["● up · http", "  note", "○ off"], glyphRoles: ["success", undefined, "muted"] };

test("S13: fallback paints only the first character of a row with its role; rows without a role stay plain", () => {
	const lines = fallbackRenderCard(painted, theme, 24);
	assert.ok(lines[1].includes("<success>●</success> up · http"), lines[1]);
	assert.ok(plain(lines[2]).includes("│   note"), lines[2]);
	assert.ok(lines[3].includes("<muted>○</muted> off"), lines[3]);
	assert.deepEqual(lines.map(plain).map((line) => [...line].length), [24, 24, 24, 24, 24]);
});

test("S13: a painted row truncates by visible width before painting, so no escape code is cut or counted", () => {
	const esc = { fg: (_role: string, text: string) => `\x1b[32m${text}\x1b[39m` };
	const lines = fallbackRenderCard({ ...painted, body: ["● a-very-long-server-name · http"], glyphRoles: ["error"] }, esc, 16);
	const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal([...visible(lines[1])].length, 16);
	assert.equal(visible(lines[1]), "│ ● a-very-lo… │");
	assert.ok(lines[1].includes("\x1b[32m●\x1b[39m"), "the glyph escape is whole");
	assert.equal((lines[1].match(/\x1b/g) ?? []).length, 6, "two frame paints and the glyph paint, each opened and closed, none orphaned");
});

test("S13: wide characters count two cells when truncating and padding", () => {
	const lines = fallbackRenderCard({ ...card, body: ["日本語日本語日本語"] }, theme, 12);
	assert.equal(plain(lines[1]), "│ 日本語…  │");
});

test("S13: the native renderer receives the glyph already painted; rows without roles are untouched", () => {
	const seen: string[][] = [];
	const native: NativeRenderCard = (c) => (seen.push(c.body), ["native"]);
	renderHudCard(painted, theme, 30, native);
	assert.deepEqual(seen[0], ["<success>●</success> up · http", "  note", "<muted>○</muted> off"]);
	renderHudCard(card, theme, 30, native);
	assert.deepEqual(seen[1], ["hello"]);
});
