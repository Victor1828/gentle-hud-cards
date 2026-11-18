import assert from "node:assert/strict";
import { test } from "node:test";
import { adviceFromBranch, adviceFromEvent, ADVICE_TOOL, createContextAdviceTool, parseAdvice, REASON_MAX, sanitizeReason } from "../lib/cards/context-advice.ts";

test("S14: the tool is registered as context_advice with a keep|compact|new_session enum and a short reason", () => {
	const tool = createContextAdviceTool();
	assert.equal(tool.name, "context_advice");
	assert.equal(ADVICE_TOOL, "context_advice");
	assert.deepEqual(tool.parameters, {
		type: "object",
		properties: { action: { type: "string", enum: ["keep", "compact", "new_session"] }, reason: { type: "string", maxLength: 40 } },
		required: ["action", "reason"],
	});
	assert.equal(REASON_MAX, 40);
});

test("S14: the guidelines name the tool, cover every action and the never-every-turn rule, and stay short", () => {
	const tool = createContextAdviceTool();
	const text = tool.promptGuidelines.join(" ");
	assert.match(text, /context_advice/);
	for (const word of ["new_session", "compact", "keep", "only when your advice changes", "never every turn", "unrelated", "stale tool output", "repeated compactions", "unless asked"]) assert.ok(text.includes(word), word);
	// Sent on every request: the whole declaration stays under ~250 tokens (~4 chars per token).
	const size = JSON.stringify({ d: tool.description, s: tool.promptSnippet, g: tool.promptGuidelines, p: tool.parameters }).length;
	assert.ok(size < 1_000, `declaration is ${size} chars`);
});

test("S14: the tool is declared directly: no exposure or defaultActive override, so Pi's defaults (direct, active) apply", () => {
	const tool = createContextAdviceTool() as Record<string, unknown>;
	assert.equal("exposure" in tool, false);
	assert.equal("defaultActive" in tool, false);
});

test("S14: execute returns a short ack and details {action, reason}, with the reason sanitized", async () => {
	const tool = createContextAdviceTool();
	const result = await tool.execute("c1", { action: "new_session", reason: "  topic\n switched \x1b[31mto\x1b[0m MCP\u0007 " });
	assert.deepEqual(result, { content: [{ type: "text", text: "Advice recorded: new_session." }], details: { action: "new_session", reason: "topic switched to MCP" } });
	assert.deepEqual((await tool.execute("c2", { action: "keep", reason: "still related" })).details, { action: "keep", reason: "still related" });
	const long = await tool.execute("c3", { action: "compact", reason: "x".repeat(100) });
	assert.equal(long.details.reason.length, 40);
});

test("S14: the tool is quiet: shell self, and call/result components render no rows", () => {
	const tool = createContextAdviceTool();
	assert.equal(tool.renderShell, "self");
	assert.deepEqual(tool.renderCall().render(80), []);
	assert.deepEqual(tool.renderResult().render(80), []);
});

test("S14: sanitizeReason strips ANSI/control characters and collapses whitespace; non-strings give an empty reason", () => {
	assert.equal(sanitizeReason("a\t\tb\r\nc \x1b[1;31mred\x1b[0m\x1b]0;title\x07 d\u0000"), "a b c red d");
	assert.equal(sanitizeReason(undefined), "");
	assert.equal(sanitizeReason(42), "");
	assert.equal(sanitizeReason("   "), "");
});

test("S14: parseAdvice: new_session/compact give advice, keep withdraws (undefined), malformed is null", () => {
	assert.deepEqual(parseAdvice({ action: "compact", reason: "long thread" }), { action: "compact", reason: "long thread" });
	assert.deepEqual(parseAdvice({ action: "new_session" }), { action: "new_session", reason: "" });
	assert.equal(parseAdvice({ action: "keep", reason: "x" }), undefined);
	for (const bad of [null, undefined, "x", 3, {}, { action: "nope" }, { action: 1 }, []]) assert.equal(parseAdvice(bad), null, JSON.stringify(bad));
});

test("S14: adviceFromEvent reads only successful context_advice results", () => {
	const ok = { toolName: "context_advice", isError: false, result: { details: { action: "new_session", reason: "r" } } };
	assert.deepEqual(adviceFromEvent(ok), { action: "new_session", reason: "r" });
	assert.equal(adviceFromEvent({ ...ok, isError: true }), null);
	assert.equal(adviceFromEvent({ ...ok, toolName: "read" }), null);
	assert.equal(adviceFromEvent({ ...ok, result: undefined }), null);
	assert.equal(adviceFromEvent(undefined), null);
});

const result = (details: unknown, extra: object = {}) => ({ type: "message", message: { role: "toolResult", toolName: "context_advice", isError: false, details, ...extra } });

test("S14: adviceFromBranch takes the latest successful result after the latest compaction", () => {
	const a = { action: "compact", reason: "one" };
	const b = { action: "new_session", reason: "two" };
	assert.deepEqual(adviceFromBranch([result(a), result(b)]), b);
	assert.equal(adviceFromBranch([result(b), { type: "compaction" }]), undefined, "advice before a compaction is ignored");
	assert.deepEqual(adviceFromBranch([result(b), { type: "compaction" }, result(a)]), a);
	assert.equal(adviceFromBranch([result(b), result({ action: "keep", reason: "" })]), undefined, "a later keep withdraws");
	assert.deepEqual(adviceFromBranch([result(a), result(b, { isError: true })]), a, "failed results are skipped");
	assert.deepEqual(adviceFromBranch([result(a), result("garbage"), result(undefined), null, { type: "message" }, { type: "message", message: null }]), a, "malformed entries are skipped");
	assert.equal(adviceFromBranch([result(a, { toolName: "other" })]), undefined);
	assert.equal(adviceFromBranch(undefined), undefined);
	assert.equal(adviceFromBranch("x"), undefined);
});
