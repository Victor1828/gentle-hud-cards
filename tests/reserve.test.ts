import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESERVE_TOKENS, readReserveTokens } from "../lib/cards/reserve.ts";

const files = (map: Record<string, string>) => (path: string) => {
	if (path in map) return map[path];
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const settings = (reserveTokens: unknown, extra: object = {}) => JSON.stringify({ compaction: { reserveTokens, ...extra } });
const run = (map: Record<string, string>, extra: { env?: Record<string, string>; model?: string } = {}) =>
	readReserveTokens({ cwd: "/proj", home: "/home/u", env: extra.env ?? {}, model: extra.model, readFile: files(map) });

test("S8: no settings files means the Pi default 16384", () => {
	assert.equal(DEFAULT_RESERVE_TOKENS, 16_384);
	assert.equal(run({}), 16_384);
});

test("S8: the global agent dir is PI_CODING_AGENT_DIR, else ~/.gentle-shell/agent, else ~/.pi/agent", () => {
	assert.equal(run({ "/env/settings.json": settings(1) }, { env: { PI_CODING_AGENT_DIR: "/env" } }), 1);
	assert.equal(run({ "/home/u/.gentle-shell/agent/settings.json": settings(2), "/home/u/.pi/agent/settings.json": settings(3) }), 2);
	assert.equal(run({ "/home/u/.pi/agent/settings.json": settings(3) }), 3);
});

test("S8: the project .pi/settings.json overrides the global one; a model override beats both", () => {
	const map = { "/home/u/.pi/agent/settings.json": settings(100), "/proj/.pi/settings.json": settings(200) };
	assert.equal(run(map), 200);
	const withModel = { ...map, "/proj/.pi/settings.json": settings(200, { modelOverrides: { "p/big": { reserveTokens: 400_000 } } }) };
	assert.equal(run(withModel, { model: "p/big" }), 400_000);
	assert.equal(run(withModel, { model: "p/other" }), 200);
});

test("S8: invalid values and broken JSON are skipped, never thrown", () => {
	const global = { "/home/u/.pi/agent/settings.json": settings(100) };
	for (const bad of [settings(-1), settings("x"), settings(1.5), "{not json", "null", "[]"]) {
		assert.equal(run({ ...global, "/proj/.pi/settings.json": bad }), 100, bad);
	}
	assert.equal(run({ "/proj/.pi/settings.json": "{not json" }), 16_384);
});
