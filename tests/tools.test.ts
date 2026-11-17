import assert from "node:assert/strict";
import { test } from "node:test";
import { branchToolCalls, categorizeTool, emptyToolCounts, toolsCard } from "../lib/cards/tools.ts";

test("S1: categorizeTool maps reads, writes, bash, memory and other", () => {
	for (const name of ["read", "grep", "find", "ls"]) assert.equal(categorizeTool(name), "reads", name);
	for (const name of ["edit", "write"]) assert.equal(categorizeTool(name), "writes", name);
	for (const name of ["bash", "bash_background", "powershell"]) assert.equal(categorizeTool(name), "bash", name);
	for (const name of ["mem_save", "mem_search", "mcp__engram__mem_context"]) assert.equal(categorizeTool(name), "memory", name);
	for (const name of ["codemode", "subagent_run", "mcp__context7__query", "todo", "", "readme", "memo"]) assert.equal(categorizeTool(name), "other", name);
});

test("S1: branchToolCalls collects assistant toolCall blocks by id and ignores everything else", () => {
	const branch = [
		{ type: "compaction" },
		{ type: "message", message: { role: "user", content: [{ type: "toolCall", id: "u1", name: "read" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "a1", name: "read" }, { type: "toolCall", id: "a2", name: "bash" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "a1", toolName: "read" } },
		{ type: "message", message: { role: "assistant", content: "plain" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }, { type: "toolCall", id: "a3", name: "mem_save" }] } },
		null,
		"junk",
	];
	assert.deepEqual([...branchToolCalls(branch)], [
		["a1", "reads"],
		["a2", "bash"],
		["a3", "memory"],
	]);
	assert.deepEqual([...branchToolCalls(undefined)], []);
});

test("S1 S9: toolsCard shows the total and one row per category, in English", () => {
	const card = toolsCard({ ...emptyToolCounts(), reads: 12, writes: 3, bash: 1, memory: 0, other: 4 });
	assert.deepEqual(card, {
		key: "hud-tools",
		title: "TOOLS",
		subtitle: "20 calls",
		tone: "info",
		body: ["Reads: 12", "Writes: 3", "Bash: 1", "Memory: 0", "Other: 4"],
	});
	assert.equal(toolsCard({ ...emptyToolCounts(), bash: 1 }).subtitle, "1 call");
});

test("S1: no calls yet shows one hint row", () => {
	assert.deepEqual(toolsCard(emptyToolCounts()), { key: "hud-tools", title: "TOOLS", subtitle: "None", tone: "info", body: ["No tool calls yet"] });
});

test("rail fit: the longest row fits 28 columns", () => {
	const card = toolsCard({ reads: 99_999, writes: 99_999, bash: 99_999, memory: 99_999, other: 99_999 });
	for (const row of [card.subtitle ?? "", ...card.body]) assert.ok(row.length <= 28, row);
});
