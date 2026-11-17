import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessContext,
	COMPACTIONS_FOR_NEW_SESSION,
	contextCard,
	formatTokens,
	MATURE_PERCENT,
	MATURE_TOKENS,
	SATURATED_PERCENT,
	SATURATED_TOKENS,
	SATURATED_TURNS_LEFT,
} from "../lib/cards/context.ts";

const base = { contextWindow: 1_000_000, reserveTokens: 16_384, compactions: 0 };

test("S8: the thresholds are named constants with the decided values", () => {
	assert.deepEqual(
		[MATURE_PERCENT, SATURATED_PERCENT, MATURE_TOKENS, SATURATED_TOKENS, SATURATED_TURNS_LEFT, COMPACTIONS_FOR_NEW_SESSION],
		[40, 70, 120_000, 200_000, 2, 1],
	);
});

// [name, input, level]
const levelTable: Array<[string, Parameters<typeof assessContext>[0], string]> = [
	["39.9% is Fresh", { ...base, contextWindow: 100_000, tokens: 39_900 }, "fresh"],
	["40% is Mature", { ...base, contextWindow: 100_000, tokens: 40_000 }, "mature"],
	["69.9% is Mature", { ...base, contextWindow: 100_000, reserveTokens: 0, tokens: 69_900 }, "mature"],
	["70% is Saturated", { ...base, contextWindow: 100_000, reserveTokens: 0, tokens: 70_000 }, "saturated"],
	["119_999 tokens is Fresh", { ...base, tokens: 119_999 }, "fresh"],
	["120_000 tokens is Mature", { ...base, tokens: 120_000 }, "mature"],
	["199_999 tokens is Mature", { ...base, tokens: 199_999 }, "mature"],
	["200_000 tokens is Saturated", { ...base, tokens: 200_000 }, "saturated"],
	["3 turns left stays Fresh", { ...base, contextWindow: 100_000, reserveTokens: 0, tokens: 10_000, avgTurnGrowth: 30_000 }, "fresh"],
];
// 100k window, reserve 0: autoCompactAt 100k, 10k used, 90k left.
for (const [name, input, level] of levelTable) {
	test(`S8: ${name}`, () => assert.equal(assessContext(input).level, level));
}

test("S8: turnsLeft 3 vs 2 around the Saturated boundary", () => {
	// window 100k, reserve 50k -> autoCompactAt 50k; 5k used -> 45k to compact.
	const three = assessContext({ ...base, contextWindow: 100_000, reserveTokens: 50_000, tokens: 5_000, avgTurnGrowth: 15_000 });
	assert.deepEqual([three.turnsLeft, three.level], [3, "fresh"]);
	const two = assessContext({ ...base, contextWindow: 100_000, reserveTokens: 50_000, tokens: 5_000, avgTurnGrowth: 22_500 });
	assert.deepEqual([two.turnsLeft, two.level, two.recommendation], [2, "saturated", "compact-now"]);
});

test("S8: derived figures", () => {
	const a = assessContext({ ...base, contextWindow: 200_000, tokens: 124_000, avgTurnGrowth: 15_000 });
	assert.deepEqual(
		[a.percent, a.autoCompactAt, a.tokensToCompact, a.turnsLeft],
		[62, 183_616, 59_616, 3],
	);
	assert.equal(assessContext({ ...base, tokens: 10, avgTurnGrowth: 0 }).turnsLeft, undefined);
	assert.equal(assessContext({ ...base, tokens: 10 }).turnsLeft, undefined);
});

test("S8: recommendation by level and compactions; Fresh never recommends a new session", () => {
	const at = (tokens: number, compactions: number) => assessContext({ ...base, tokens, compactions });
	assert.equal(at(1_000, 0).recommendation, "keep-going");
	assert.equal(at(1_000, 1).recommendation, "keep-going");
	assert.equal(at(1_000, 5).recommendation, "keep-going");
	assert.equal(at(120_000, 0).recommendation, "compact-later");
	assert.equal(at(120_000, 1).recommendation, "new-session");
	assert.equal(at(200_000, 0).recommendation, "compact-now");
	assert.equal(at(200_000, 1).recommendation, "new-session");
});

test("S8: unknown tokens give an unknown assessment without throwing", () => {
	for (const tokens of [null, undefined]) {
		const a = assessContext({ ...base, tokens, compactions: 2 });
		assert.deepEqual([a.level, a.percent, a.recommendation, a.turnsLeft], ["unknown", undefined, undefined, undefined]);
		assert.equal(a.autoCompactAt, 983_616);
	}
});

test("S8: a window smaller than reserveTokens clamps tokensToCompact to 0", () => {
	const a = assessContext({ contextWindow: 10_000, reserveTokens: 16_384, compactions: 0, tokens: 1_000, avgTurnGrowth: 500 });
	assert.deepEqual([a.autoCompactAt, a.tokensToCompact, a.turnsLeft, a.level], [-6_384, 0, 0, "saturated"]);
});

test("S9: formatTokens", () => {
	const cases: Array<[number, string]> = [[0, "0"], [999, "999"], [1_000, "1k"], [1_234, "1.2k"], [59_616, "59.6k"], [124_000, "124k"], [999_999, "1M"], [1_000_000, "1M"], [1_500_000, "1.5M"]];
	for (const [n, text] of cases) assert.equal(formatTokens(n), text, String(n));
});

const card = (input: Parameters<typeof assessContext>[0]) => contextCard(assessContext(input));

test("S3/S9: Fresh card is info with exact English rows", () => {
	assert.deepEqual(card({ ...base, contextWindow: 200_000, tokens: 40_000, avgTurnGrowth: 20_000 }), {
		key: "hud-context",
		title: "CONTEXT+",
		subtitle: "Fresh",
		tone: "info",
		body: ["20% · 40k / 200k", "Compact in 144k · ~7 turns", "Compactions: 0", "→ Keep going"],
	});
});

test("S3/S9: Mature is warning, Saturated is error, with the recommendation lines", () => {
	const mature = card({ ...base, contextWindow: 200_000, tokens: 124_000, avgTurnGrowth: 15_000 });
	assert.deepEqual([mature.tone, mature.subtitle, mature.body], ["warning", "Mature", ["62% · 124k / 200k", "Compact in 59.6k · ~3 turns", "Compactions: 0", "→ /compact at next break"]]);
	const saturated = card({ ...base, tokens: 250_000 });
	assert.deepEqual([saturated.tone, saturated.subtitle, saturated.body[3]], ["error", "Saturated", "→ /compact now"]);
	const fresh = card({ ...base, tokens: 5_000, compactions: 1 });
	assert.equal(fresh.body[3], "→ Keep going");
	assert.equal(card({ ...base, tokens: 130_000, compactions: 1 }).body[3], "→ Start a new session");
	assert.equal(card({ ...base, tokens: 250_000, compactions: 3 }).body[3], "→ Start a new session");
});

test("S9: the turns part is omitted when unknown; singular turn; due now", () => {
	assert.equal(card({ ...base, tokens: 40_000 }).body[1], "Compact in 944k");
	assert.equal(card({ ...base, contextWindow: 100_000, reserveTokens: 50_000, tokens: 5_000, avgTurnGrowth: 40_000 }).body[1], "Compact in 45k · ~1 turn");
	assert.equal(card({ contextWindow: 10_000, reserveTokens: 16_384, compactions: 0, tokens: 1_000 }).body[1], "Auto-compact due now");
});

test("S9: unknown tokens render an unknown card", () => {
	assert.deepEqual(card({ ...base, tokens: null, compactions: 1 }), {
		key: "hud-context",
		title: "CONTEXT+",
		subtitle: "Unknown",
		tone: "info",
		body: ["Usage unknown", "Compactions: 1"],
	});
});

test("S3: card rows stay short enough for the rail", () => {
	const c = card({ ...base, tokens: 130_000, compactions: 12, avgTurnGrowth: 1_000 });
	for (const row of c.body) assert.ok([...row].length <= 40, row);
});

test("S3: every row fits the ~30-column rail for realistic sessions", () => {
	const cases = [
		{ tokens: 60_000, contextWindow: 1_000_000, reserveTokens: 16_384, compactions: 0, avgTurnGrowth: 8_000 },
		{ tokens: 152_000, contextWindow: 1_000_000, reserveTokens: 16_384, compactions: 0, avgTurnGrowth: 7_000 },
		{ tokens: 152_000, contextWindow: 200_000, reserveTokens: 16_384, compactions: 12, avgTurnGrowth: 9_000 },
		{ tokens: 1_500, contextWindow: 1_000_000, reserveTokens: 16_384, compactions: 0, avgTurnGrowth: 10 },
	];
	for (const input of cases) for (const row of contextCard(assessContext(input)).body) assert.ok([...row].length <= 28, `${row} (${[...row].length})`);
	assert.equal(contextCard(assessContext(cases[3])).body[1], "Compact in 982k · ~99+ turns");
});
