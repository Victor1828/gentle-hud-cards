import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SERVER_ROWS, mcpAgentDir, mcpCard, readMcpConfig, type McpConfigResult } from "../lib/cards/mcp.ts";

const SECRET = "s3cr3t-token-value";
const AGENT = "/agent";
const CWD = "/proj";

/** In-memory files; a value of Error makes the read throw it. */
function fs(files: Record<string, string | Error>) {
	const reads: string[] = [];
	return {
		reads,
		readFile: (path: string) => {
			reads.push(path);
			const file = files[path];
			if (file === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			if (file instanceof Error) throw file;
			return file;
		},
		exists: (path: string) => files[path] !== undefined,
	};
}
const json = (servers: unknown) => JSON.stringify({ mcpServers: servers });

const globalServers = {
	clickup: { url: "https://mcp.example/clickup", headers: { Authorization: `Bearer ${SECRET}` } },
	engram: { command: "engram", args: ["mcp", SECRET], env: { TOKEN: SECRET } },
	grafana: { url: "https://grafana.example", enabled: false },
	typed: { type: "http", url: "https://x.example" },
	piped: { type: "stdio", command: "x" },
	legacy: { type: "sse", url: "https://old.example" },
	empty: { description: "nothing to run" },
	weird: "not an object",
};

test("S1: global servers with transport and enabled; secrets never leave the reader", () => {
	const f = fs({ [`${AGENT}/mcp.json`]: json(globalServers) });
	const result = readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: false, readFile: f.readFile, exists: f.exists });
	assert.deepEqual(result.servers, [
		{ name: "clickup", transport: "http", enabled: true, source: "global" },
		{ name: "engram", transport: "stdio", enabled: true, source: "global" },
		{ name: "grafana", transport: "http", enabled: false, source: "global" },
		{ name: "typed", transport: "http", enabled: true, source: "global" },
		{ name: "piped", transport: "stdio", enabled: true, source: "global" },
		{ name: "legacy", transport: "invalid", enabled: true, source: "global" },
		{ name: "empty", transport: "invalid", enabled: true, source: "global" },
		{ name: "weird", transport: "invalid", enabled: false, source: "global" },
	]);
	assert.deepEqual(result.errors, []);
	assert.equal(result.projectIgnored, false);
	assert.ok(!JSON.stringify(result).includes(SECRET), "no env, header, arg or url value is kept");
	assert.ok(!JSON.stringify(result).includes("example"), "urls are not kept");
});

test("S1: a trusted project replaces same-name servers, adds new ones, and an override-only entry sets enabled", () => {
	const f = fs({
		[`${AGENT}/mcp.json`]: json({ clickup: { url: "https://a" }, engram: { command: "engram" }, grafana: { url: "https://g" } }),
		[`${CWD}/.pi/mcp.json`]: json({ clickup: { command: "local-clickup" }, grafana: { enabled: false }, local: { url: "http://localhost:9" }, ghost: { enabled: true } }),
	});
	const result = readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: true, readFile: f.readFile, exists: f.exists });
	assert.deepEqual(result.servers, [
		{ name: "clickup", transport: "stdio", enabled: true, source: "project" },
		{ name: "engram", transport: "stdio", enabled: true, source: "global" },
		{ name: "grafana", transport: "http", enabled: false, source: "global" },
		{ name: "local", transport: "http", enabled: true, source: "project" },
	]);
	assert.deepEqual(result.errors, []);
	assert.equal(result.projectIgnored, false);
});

test("S1: an untrusted project's mcp.json is never read, and is flagged only when it exists", () => {
	const withFile = fs({ [`${AGENT}/mcp.json`]: json({ a: { command: "a" } }), [`${CWD}/.pi/mcp.json`]: json({ b: { command: "b" } }) });
	const result = readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: false, readFile: withFile.readFile, exists: withFile.exists });
	assert.deepEqual(result.servers.map((s) => s.name), ["a"]);
	assert.equal(result.projectIgnored, true);
	assert.deepEqual(withFile.reads, [`${AGENT}/mcp.json`]);
	const without = fs({ [`${AGENT}/mcp.json`]: json({ a: { command: "a" } }) });
	assert.equal(readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: false, readFile: without.readFile, exists: without.exists }).projectIgnored, false);
});

test("S1: missing files are not errors; invalid JSON, a bad mcpServers, and unreadable files are, per file", () => {
	const none = fs({});
	assert.deepEqual(readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: true, readFile: none.readFile, exists: none.exists }), { servers: [], errors: [], projectIgnored: false });

	const bad = fs({
		[`${AGENT}/mcp.json`]: "{ not json",
		[`${CWD}/.pi/mcp.json`]: JSON.stringify({ mcpServers: ["x"] }),
	});
	const r1 = readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: true, readFile: bad.readFile, exists: bad.exists });
	assert.deepEqual(r1, { servers: [], errors: ["global mcp.json invalid", "project mcp.json invalid"], projectIgnored: false });

	const denied = fs({ [`${AGENT}/mcp.json`]: Object.assign(new Error("EACCES"), { code: "EACCES" }), [`${CWD}/.pi/mcp.json`]: json({ p: { command: "p" } }) });
	const r2 = readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: true, readFile: denied.readFile, exists: denied.exists });
	assert.deepEqual(r2, { servers: [{ name: "p", transport: "stdio", enabled: true, source: "project" }], errors: ["global mcp.json unreadable"], projectIgnored: false });

	const noKey = fs({ [`${AGENT}/mcp.json`]: "{}" });
	assert.deepEqual(readMcpConfig({ agentDir: AGENT, cwd: CWD, projectTrusted: false, readFile: noKey.readFile, exists: noKey.exists }).errors, []);
});

test("S1: without a cwd only the global file is read", () => {
	const f = fs({ [`${AGENT}/mcp.json`]: json({ a: { command: "a" } }) });
	const result = readMcpConfig({ agentDir: AGENT, projectTrusted: true, readFile: f.readFile, exists: f.exists });
	assert.deepEqual(result.servers.map((s) => s.name), ["a"]);
	assert.deepEqual(f.reads, [`${AGENT}/mcp.json`]);
});

test("mcpAgentDir follows Pi's getAgentDir: PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
	assert.equal(mcpAgentDir({ PI_CODING_AGENT_DIR: "/Users/me/.gentle-shell/agent" }, "/Users/me"), "/Users/me/.gentle-shell/agent");
	assert.equal(mcpAgentDir({}, "/Users/me"), "/Users/me/.pi/agent");
	assert.equal(mcpAgentDir({ PI_CODING_AGENT_DIR: "" }, "/Users/me"), "/Users/me/.pi/agent");
});

const server = (name: string, transport: "stdio" | "http" | "invalid", enabled = true) => ({ name, transport, enabled, source: "global" as const });

test("S1/S9: card copy for mixed servers", () => {
	const result: McpConfigResult = { servers: [server("clickup", "http"), server("engram", "stdio"), server("grafana", "http", false), server("legacy", "invalid")], errors: [], projectIgnored: false };
	assert.deepEqual(mcpCard(result), {
		key: "hud-mcp",
		title: "MCP",
		subtitle: "2/4 on",
		tone: "info",
		body: ["● clickup · http", "● engram · stdio", "○ grafana · off", "✕ legacy · invalid"],
	});
});

test("S1/S9: no servers, errors, untrusted project, and the row cap", () => {
	assert.deepEqual(mcpCard({ servers: [], errors: [], projectIgnored: false }), { key: "hud-mcp", title: "MCP", subtitle: "None", tone: "info", body: ["No servers configured"] });

	const warn = mcpCard({ servers: [server("a", "stdio")], errors: ["project mcp.json invalid"], projectIgnored: true });
	assert.equal(warn.tone, "warning");
	assert.deepEqual(warn.body, ["● a · stdio", "⚠ project mcp.json invalid", "Project mcp.json untrusted"]);

	const many = Array.from({ length: MAX_SERVER_ROWS + 3 }, (_, i) => server(`s${i}`, "stdio"));
	const capped = mcpCard({ servers: many, errors: [], projectIgnored: false });
	assert.equal(capped.body.length, MAX_SERVER_ROWS + 1);
	assert.equal(capped.body.at(-1), "+3 more");
	assert.equal(capped.subtitle, `${MAX_SERVER_ROWS + 3}/${MAX_SERVER_ROWS + 3} on`);
});

test("S3: fixed rows fit the ~28-column rail", () => {
	const rows = [
		...mcpCard({ servers: [], errors: ["global mcp.json unreadable", "project mcp.json invalid"], projectIgnored: true }).body,
		"No servers configured",
		"+99 more",
	];
	for (const row of rows) assert.ok([...row].length <= 28, `${row} is ${[...row].length} columns`);
});
