import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolsProvider } from "../lib/cards/tools-live.ts";

const call = (id: string, name: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name }] } });
const end = (toolCallId: string | undefined, toolName: string, extra: Record<string, unknown> = {}) => ({ type: "tool_execution_end", toolCallId, toolName, isError: false, ...extra });

function setup(branch: unknown[] = []) {
	const provider = createToolsProvider();
	let changes = 0;
	provider.watch?.(() => changes++);
	const ctx = { sessionManager: { getBranch: () => branch } };
	return { provider, ctx, branch, changes: () => changes };
}

test("S1: no card before session_start", () => {
	assert.equal(createToolsProvider().card(), undefined);
});

test("S1: session_start rebuilds the counts from the branch (resume, reload, fork)", () => {
	const t = setup([call("a1", "read"), call("a2", "grep"), call("a3", "edit"), call("a4", "mem_search")]);
	t.provider.update?.({ type: "session_start" }, t.ctx);
	assert.equal(t.provider.card()?.subtitle, "4 calls");
	assert.deepEqual(t.provider.card()?.body, ["Reads: 2", "Writes: 1", "Bash: 0", "Memory: 1", "Other: 0"]);
});

test("S1: tool_execution_end counts each model-issued call once and notifies the watcher", () => {
	const t = setup();
	t.provider.update?.({ type: "session_start" }, t.ctx);
	t.provider.update?.(end("b1", "bash"), t.ctx);
	t.provider.update?.(end("b2", "bash", { isError: true }), t.ctx);
	t.provider.update?.(end("b1", "bash"), t.ctx);
	assert.deepEqual(t.provider.card()?.body, ["Reads: 0", "Writes: 0", "Bash: 2", "Memory: 0", "Other: 0"]);
	assert.equal(t.changes(), 2, "a duplicate end does not notify");
});

test("S1: nested calls (codemode inner calls) are not counted", () => {
	const t = setup();
	t.provider.update?.({ type: "session_start" }, t.ctx);
	t.provider.update?.(end("c1/1", "read", { parentToolCallId: "c1" }), t.ctx);
	t.provider.update?.(end("c1/2", "read"), t.ctx);
	t.provider.update?.(end("c1", "codemode"), t.ctx);
	assert.equal(t.provider.card()?.subtitle, "1 call");
	assert.deepEqual(t.provider.card()?.body, ["Reads: 0", "Writes: 0", "Bash: 0", "Memory: 0", "Other: 1"]);
	assert.equal(t.changes(), 1);
});

test("S1: a live call later found in the branch is not counted twice; turn_end adds branch calls the events missed", () => {
	const t = setup();
	t.provider.update?.({ type: "session_start" }, t.ctx);
	t.provider.update?.(end("d1", "write"), t.ctx);
	t.branch.push(call("d1", "write"), call("d2", "ls"));
	t.provider.update?.({ type: "turn_end" }, t.ctx);
	assert.deepEqual(t.provider.card()?.body, ["Reads: 1", "Writes: 1", "Bash: 0", "Memory: 0", "Other: 0"]);
});

test("S1: a new session_start resets the counts to the new branch", () => {
	const t = setup();
	t.provider.update?.({ type: "session_start" }, t.ctx);
	t.provider.update?.(end("e1", "bash"), t.ctx);
	t.provider.update?.({ type: "session_start" }, { sessionManager: { getBranch: () => [] } });
	assert.deepEqual(t.provider.card()?.body, ["No tool calls yet"]);
});

test("resilience: a throwing or missing getBranch and an end without id or name do not throw", () => {
	const provider = createToolsProvider();
	assert.doesNotThrow(() => provider.update?.({ type: "session_start" }, { sessionManager: { getBranch: () => { throw new Error("boom"); } } }));
	assert.doesNotThrow(() => provider.update?.({ type: "turn_end" }, {}));
	provider.update?.({ type: "tool_execution_end" }, {});
	provider.update?.({ type: "tool_execution_end", toolName: "read" }, {});
	provider.update?.({ type: "tool_execution_end", toolName: "read" }, {});
	assert.deepEqual(provider.card()?.body, ["Reads: 2", "Writes: 0", "Bash: 0", "Memory: 0", "Other: 1"]);
});

test("S1: events before session_start are ignored", () => {
	const t = setup();
	t.provider.update?.(end("f1", "read"), t.ctx);
	assert.equal(t.provider.card(), undefined);
	assert.equal(t.changes(), 0);
});
