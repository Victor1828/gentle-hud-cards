import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpConfigResult } from "../lib/cards/mcp.ts";
import { createMcpProvider } from "../lib/cards/mcp-live.ts";

function setup(read: (input: { cwd?: string; projectTrusted: boolean }) => McpConfigResult) {
	const calls: Array<{ cwd?: string; projectTrusted: boolean }> = [];
	const provider = createMcpProvider({
		read: (input) => {
			calls.push(input);
			return read(input);
		},
	});
	return { provider, calls };
}
const one: McpConfigResult = { servers: [{ name: "engram", transport: "stdio", enabled: true, source: "global" }], errors: [], projectIgnored: false };

test("S1: no card before session_start", () => {
	assert.equal(setup(() => one).provider.card(), undefined);
});

test("S1: reads on session_start with ctx.cwd and ctx.isProjectTrusted(), not on later events", () => {
	const t = setup(() => one);
	t.provider.update?.({ type: "session_start" }, { cwd: "/work", isProjectTrusted: () => true });
	assert.deepEqual(t.calls, [{ cwd: "/work", projectTrusted: true }]);
	assert.deepEqual(t.provider.card()?.body, ["● engram · stdio"]);
	for (const type of ["turn_end", "message_end", "session_compact"]) t.provider.update?.({ type }, { cwd: "/work", isProjectTrusted: () => true });
	assert.equal(t.calls.length, 1);
});

test("S1: without isProjectTrusted, or when it throws, the project is treated as untrusted", () => {
	const t = setup(() => one);
	t.provider.update?.({ type: "session_start" }, { cwd: "/a" });
	t.provider.update?.({ type: "session_start" }, {
		cwd: "/b",
		isProjectTrusted: () => {
			throw new Error("no trust store");
		},
	});
	assert.deepEqual(t.calls, [{ cwd: "/a", projectTrusted: false }, { cwd: "/b", projectTrusted: false }]);
});

test("S1: a reader that throws shows an unreadable-config card instead of breaking", () => {
	const t = setup(() => {
		throw new Error("boom");
	});
	t.provider.update?.({ type: "session_start" }, { cwd: "/a" });
	const card = t.provider.card();
	assert.equal(card?.tone, "warning");
	assert.deepEqual(card?.body, ["No servers configured", "⚠ MCP config unreadable"]);
});
