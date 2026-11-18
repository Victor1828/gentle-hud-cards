import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpConfigResult } from "../lib/cards/mcp.ts";
import { createMcpProvider, statusCwd, type McpProviderOptions } from "../lib/cards/mcp-live.ts";
import type { McpServerStatus } from "../lib/cards/mcp-status.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const unavailable = () => Promise.reject(new Error("no pi"));

function setup(read: (input: { cwd?: string; projectTrusted: boolean }) => McpConfigResult, runStatus: McpProviderOptions["runStatus"] = unavailable) {
	const calls: Array<{ cwd?: string; projectTrusted: boolean }> = [];
	const provider = createMcpProvider({
		read: (input) => {
			calls.push(input);
			return read(input);
		},
		runStatus,
	});
	return { provider, calls };
}
const one: McpConfigResult = { servers: [{ name: "engram", transport: "stdio", enabled: true, source: "global" }], errors: [], projectIgnored: false };

test("S1: no card before session_start", () => {
	assert.equal(setup(() => one).provider.card(), undefined);
});

test("S1: reads on session_start with ctx.cwd and ctx.isProjectTrusted(), not on later events", async () => {
	const t = setup(() => one);
	t.provider.update?.({ type: "session_start" }, { cwd: "/work", isProjectTrusted: () => true });
	assert.deepEqual(t.calls, [{ cwd: "/work", projectTrusted: true }]);
	assert.deepEqual(t.provider.card()?.body, ["● engram · checking"]);
	await tick();
	assert.deepEqual(t.provider.card()?.body, ["● engram · stdio", "⚠ Status unavailable"], "S13: with the runner unavailable the card keeps today's config rows");
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

// ---- S13: live status ----

const status = (name: string, state: string, preview?: string): McpServerStatus => ({ name, state, transport: "http", enabled: true, ...(preview ? { preview } : {}) });
const config = (...names: string[]): McpConfigResult => ({ servers: names.map((name) => ({ name, transport: "http" as const, enabled: true, source: "global" as const })), errors: [], projectIgnored: false });
const ctx = { cwd: "/work", isProjectTrusted: () => true };
const toolEnd = (toolName: string, isError: boolean, text?: string, extra: object = {}) => ({
	type: "tool_execution_end",
	toolCallId: "c1",
	toolName,
	isError,
	result: text === undefined ? undefined : { content: [{ type: "text", text }] },
	...extra,
});

function deferred() {
	let resolve!: (value: McpServerStatus[]) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<McpServerStatus[]>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

test("S13: session_start starts one check with cwd, trust and an abort signal; the card shows `checking`, then the merged status, and watchers are told", async () => {
	const runs: Array<{ cwd?: string; projectTrusted: boolean; signal?: AbortSignal }> = [];
	const d = deferred();
	const t = setup(() => config("clickup", "pganalyze"), (input) => (runs.push(input), d.promise));
	let renders = 0;
	t.provider.watch?.(() => renders++);
	t.provider.update?.({ type: "session_start" }, ctx);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].cwd, "/work");
	assert.equal(runs[0].projectTrusted, true);
	assert.equal(runs[0].signal?.aborted, false);
	assert.equal(t.provider.card()?.subtitle, "checking");
	for (const type of ["turn_end", "message_end", "session_compact"]) t.provider.update?.({ type }, ctx);
	assert.equal(runs.length, 1, "later events never re-run the check");
	d.resolve([status("clickup", "connected"), status("pganalyze", "failed", "401 Unauthorized")]);
	await tick();
	assert.equal(renders, 1);
	const card = t.provider.card();
	assert.equal(card?.subtitle, "1/2 online");
	assert.deepEqual(card?.body, ["● pganalyze · failed", "  401 Unauthorized", "● clickup · http"]);
	assert.equal(card?.tone, "warning");
});

test("S13: an untrusted project is passed to the runner as untrusted", () => {
	const runs: Array<{ projectTrusted: boolean }> = [];
	const t = setup(() => config("a"), (input) => (runs.push(input), new Promise(() => {})));
	t.provider.update?.({ type: "session_start" }, { cwd: "/work" });
	assert.deepEqual(runs.map((run) => run.projectTrusted), [false]);
});

test("S13: a stale result is dropped when a newer session_start began, and the older run is aborted", async () => {
	const first = deferred();
	const second = deferred();
	const queue = [first, second];
	const signals: AbortSignal[] = [];
	const t = setup(() => config("a"), (input) => (signals.push(input.signal!), queue.shift()!.promise));
	let renders = 0;
	t.provider.watch?.(() => renders++);
	t.provider.update?.({ type: "session_start" }, ctx);
	t.provider.update?.({ type: "session_start" }, ctx);
	assert.equal(signals[0].aborted, true);
	assert.equal(signals[1].aborted, false);
	first.resolve([status("a", "failed", "STALE")]);
	await tick();
	assert.equal(renders, 0);
	assert.deepEqual(t.provider.card()?.body, ["● a · checking"]);
	second.resolve([status("a", "connected")]);
	await tick();
	assert.deepEqual(t.provider.card()?.body, ["● a · http"]);
	first.reject(new Error("late"));
	await tick();
	assert.deepEqual(t.provider.card()?.body, ["● a · http"], "a stale failure does not flip the card to unavailable");
});

test("S13: a runner that throws synchronously or rejects shows `Status unavailable`", async () => {
	const sync = setup(() => config("a"), () => {
		throw new Error("spawn");
	});
	sync.provider.update?.({ type: "session_start" }, ctx);
	await tick();
	assert.deepEqual(sync.provider.card()?.body, ["● a · http", "⚠ Status unavailable"]);
});

test("S13: a failed tool call of mcp__<server>__<tool> turns that server red with a redacted preview; a later success clears it", async () => {
	const t = setup(() => config("clickup", "engram"), () => Promise.resolve([status("clickup", "connected"), status("engram", "connected")]));
	let renders = 0;
	t.provider.watch?.(() => renders++);
	t.provider.update?.({ type: "session_start" }, ctx);
	await tick();
	renders = 0;
	t.provider.update?.(toolEnd("mcp__clickup__create_task", true, "HTTP 401 Unauthorized\nAuthorization: Bearer sk-live-AbCdEf0123456789xyz"), ctx);
	assert.equal(renders, 1);
	assert.deepEqual(t.provider.card()?.body, ["● clickup · failed", "  HTTP 401 Unauthorized", "● engram · http"]);
	assert.ok(!JSON.stringify(t.provider.card()).includes("sk-live"));
	t.provider.update?.(toolEnd("mcp__engram__mem_save", false, "ok"), ctx);
	assert.equal(t.provider.card()?.body[0], "● clickup · failed", "another server's success does not clear it");
	t.provider.update?.(toolEnd("mcp__clickup__list_tasks", false, "fine"), ctx);
	assert.deepEqual(t.provider.card()?.body, ["● clickup · http", "● engram · http"]);
	assert.equal(t.provider.card()?.subtitle, "2/2 online");
});

test("S13: live errors apply even before the check lands, and a new session_start forgets them", async () => {
	const t = setup(() => config("a"), () => new Promise(() => {}));
	t.provider.update?.({ type: "session_start" }, ctx);
	t.provider.update?.(toolEnd("mcp__a__x", true, "boom"), ctx);
	assert.deepEqual(t.provider.card()?.body, ["● a · failed", "  boom"]);
	t.provider.update?.({ type: "session_start" }, ctx);
	assert.deepEqual(t.provider.card()?.body, ["● a · checking"]);
});

test("S13: names are mapped like Pi: non-alphanumerics become `_`; collision-hashed tool suffixes and nested calls still map", async () => {
	const t = setup(() => config("my-server", "other.srv"), unavailable);
	t.provider.update?.({ type: "session_start" }, ctx);
	t.provider.update?.(toolEnd("mcp__my_server__do-thing_ab12cd", true, "bad"), ctx);
	t.provider.update?.(toolEnd("mcp__other_srv__t", true, "worse", { parentToolCallId: "p", toolCallId: "p/1" }), ctx);
	await tick();
	assert.deepEqual(t.provider.card()?.body.filter((row) => row.startsWith("●")), ["● my-server · failed", "● other.srv · failed"]);
});

test("S13: unmappable or non-MCP tool names are ignored; an ambiguous prefix is ignored too", async () => {
	const t = setup(() => config("a", "a__b"), unavailable);
	t.provider.update?.({ type: "session_start" }, ctx);
	await tick();
	const before = JSON.stringify(t.provider.card());
	for (const name of ["bash", "mcp__ghost__x", "mcp__", "mcp__a", "mcp__a__", "mcp____x", "mcp__a__b__x", 42 as unknown as string, undefined as unknown as string]) t.provider.update?.(toolEnd(name, true, "boom"), ctx);
	assert.equal(JSON.stringify(t.provider.card()), before);
	t.provider.update?.(toolEnd("mcp__a__x", true, "boom"), ctx);
	assert.equal(t.provider.card()?.body[0], "● a · failed");
});

test("S13: a failing call with no usable result text still turns the server red, with a generic preview", async () => {
	const t = setup(() => config("a"), unavailable);
	t.provider.update?.({ type: "session_start" }, ctx);
	t.provider.update?.(toolEnd("mcp__a__x", true), ctx);
	t.provider.update?.({ ...toolEnd("mcp__a__x", true), result: { content: [{ type: "image" }] } }, ctx);
	await tick();
	assert.deepEqual(t.provider.card()?.body.slice(0, 2), ["● a · failed", "  tool call failed"]);
});

test("S13/Risk 2: secrets in live errors and CLI errors never reach the card, and watchers get no payload", async () => {
	const SECRET = "hunter2pass";
	const d = deferred();
	const t = setup(() => config("a", "b"), () => d.promise);
	const payloads: unknown[][] = [];
	t.provider.watch?.((...args: unknown[]) => payloads.push(args));
	t.provider.update?.({ type: "session_start" }, ctx);
	d.resolve([status("a", "failed", "ready")]);
	await tick();
	t.provider.update?.(toolEnd("mcp__b__x", true, `connect https://u:${SECRET}@h.example/mcp?token=${SECRET} password=${SECRET}`), ctx);
	assert.ok(!JSON.stringify(t.provider.card()).includes(SECRET));
	assert.ok(payloads.every((args) => args.length === 0));
});

test("S13: the status cwd is the session cwd for a trusted project and the agent dir for an untrusted one, so project mcp.json is never loaded", () => {
	assert.equal(statusCwd({ cwd: "/work", projectTrusted: true, agentDir: "/agent" }), "/work");
	assert.equal(statusCwd({ cwd: "/work", projectTrusted: false, agentDir: "/agent" }), "/agent");
	assert.equal(statusCwd({ cwd: undefined, projectTrusted: true, agentDir: "/agent" }), "/agent");
});

test("Risk 2 advisory: a huge failing tool result is capped on the live path too", async () => {
	const t = setup(() => config("a"), unavailable);
	t.provider.update?.({ type: "session_start" }, ctx);
	const started = Date.now();
	t.provider.update?.(toolEnd("mcp__a__x", true, "a://".repeat(250_000)), ctx);
	assert.ok(Date.now() - started < 200);
	assert.equal(t.provider.card()?.body[0], "● a · failed");
});
