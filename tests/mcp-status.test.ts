import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { errorPreview, parseMcpList, PREVIEW_COLUMNS, resolvePiCli, runPiMcpList } from "../lib/cards/mcp-status.ts";

// A fake `pi` CLI: a script that prints what the test asks, so no real Pi or server ever runs.
function fake(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "hud-mcp-status-"));
	const cli = join(dir, "cli.js");
	writeFileSync(cli, body);
	return { dir, cli, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (cli: string, options: Partial<Parameters<typeof runPiMcpList>[0]> = {}) => runPiMcpList({ cliPath: cli, cwd: tmpdir(), ...options });

test("S13: the runner launches `<cli> mcp list --json` with node, the given cwd, and the inherited env", async () => {
	// The fake reports what it observed in the server name, which the parser keeps.
	const f = fake(`
const { realpathSync } = require("node:fs");
const seen = [process.argv.slice(2).join(" "), realpathSync(process.cwd()), process.env.HUD_PROBE ?? "unset", String(process.stdin.isTTY === true)];
console.log(JSON.stringify({ servers: [{ name: seen.join("|"), state: "connected", transport: "node", enabled: true }] }));
`);
	try {
		const [server] = await run(f.cli, { env: { ...process.env, HUD_PROBE: "yes" }, cwd: f.dir });
		assert.equal(server.name, ["mcp list --json", realpathSync(f.dir), "yes", "false"].join("|"));
	} finally {
		f.done();
	}
});

test("S13: a non-zero exit with valid JSON is a result (Pi exits 1 when any server failed)", async () => {
	const f = fake(`console.log(JSON.stringify({ servers: [{ name: "a", state: "failed", transport: "https://x.example/mcp", enabled: true, error: "401 Unauthorized" }] })); process.exit(1);`);
	try {
		assert.deepEqual(await run(f.cli), [{ name: "a", state: "failed", transport: "http", enabled: true, preview: "401 Unauthorized" }]);
	} finally {
		f.done();
	}
});

test("S13: invalid JSON, a wrong shape, and a crash with no output all reject", async () => {
	for (const body of [`console.log("not json")`, `console.log(JSON.stringify({ nope: 1 }))`, `process.exit(3)`, `console.log("[]")`]) {
		const f = fake(body);
		try {
			await assert.rejects(run(f.cli), undefined, body);
		} finally {
			f.done();
		}
	}
});

test("S13: a run past the timeout is killed with its whole process tree and rejects", async () => {
	const f = fake(`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(process.env.HUD_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
`);
	const pidFile = join(f.dir, "pid");
	try {
		const started = Date.now();
		await assert.rejects(run(f.cli, { timeoutMs: 400, env: { ...process.env, HUD_PID_FILE: pidFile } }), /timed out/);
		assert.ok(Date.now() - started < 5000);
		const pid = Number(readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.throws(() => process.kill(pid, 0), "the grandchild is gone");
	} finally {
		f.done();
	}
});

test("S13: stdout over the size cap kills the run and rejects", async () => {
	const f = fake(`process.stdout.write("x".repeat(5000)); setInterval(() => {}, 1000);`);
	try {
		await assert.rejects(run(f.cli, { maxBytes: 1000 }), /too large/);
	} finally {
		f.done();
	}
});

test("S13: an aborted signal kills the run and rejects", async () => {
	const f = fake(`setInterval(() => {}, 1000);`);
	try {
		const controller = new AbortController();
		const pending = run(f.cli, { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		await assert.rejects(pending, /aborted/);
	} finally {
		f.done();
	}
});

test("S13: a missing CLI rejects without throwing synchronously", async () => {
	await assert.rejects(runPiMcpList({ cliPath: "/nonexistent/cli.js", cwd: tmpdir() }));
});

test("S13: parseMcpList keeps only name, state, transport kind, enabled and a preview; everything else is dropped", () => {
	const out = parseMcpList(
		JSON.stringify({
			servers: [
				{ name: "clickup", scope: "global", source: "/home/u/.gentle-shell/agent/mcp.json", enabled: true, exposure: "codemode", transport: "https://user:pw@mcp.example/mcp?token=SECRETQ", authProvider: "p", state: "connected", tools: ["a", "b"], resources: true },
				{ name: "engram", enabled: true, transport: "/usr/bin/engram mcp --key=ARGSECRET", state: "failed", tools: [], error: "spawn ENOENT\n  at stack" },
				{ name: "grafana", enabled: false, transport: "https://g.example", state: "disabled", tools: [] },
				{ nope: true },
				{ name: 5, state: "connected" },
			],
			errors: ["config error with SECRETCFG"],
			note: "NOTE",
		}),
	);
	assert.deepEqual(out, [
		{ name: "clickup", state: "connected", transport: "http", enabled: true },
		{ name: "engram", state: "failed", transport: "stdio", enabled: true, preview: "spawn ENOENT" },
		{ name: "grafana", state: "disabled", transport: "http", enabled: false },
	]);
	const text = JSON.stringify(out);
	for (const leak of ["SECRETQ", "ARGSECRET", "SECRETCFG", "NOTE", "pw", "mcp.example", "mcp.json"]) assert.ok(!text.includes(leak), leak);
});

test("S13: parseMcpList returns undefined for anything that is not a servers list", () => {
	for (const text of ["", "x", "{}", "[]", "null", JSON.stringify({ servers: "no" })]) assert.equal(parseMcpList(text), undefined, text);
});

test("S13: resolvePiCli finds the bin of the pi-coding-agent under gentle-pi, else a hoisted sibling, else undefined", () => {
	const pkg = JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } });
	const files: Record<string, string> = { "/gp/node_modules/@earendil-works/pi-coding-agent/package.json": pkg };
	const read = (path: string) => {
		if (files[path] === undefined) throw new Error("ENOENT");
		return files[path];
	};
	assert.equal(resolvePiCli("/gp", read), "/gp/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	assert.equal(resolvePiCli("/other", read), undefined);
	assert.equal(resolvePiCli(undefined, read), undefined);
	const hoisted = { "/nm/@earendil-works/pi-coding-agent/package.json": pkg };
	assert.equal(resolvePiCli("/nm/gentle-pi", (p) => (hoisted as Record<string, string>)[p] ?? read(p)), "/nm/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
});

// ---- Risk item 2: the preview must never carry a credential ----

const SECRETS = ["sk-live-AbCdEf0123456789xyz", "hunter2pass", "Zm9vOmJhcg==", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"];
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const REALISTIC: Array<[string, string, RegExp?]> = [
	["http header", "Authorization: Bearer sk-live-AbCdEf0123456789xyz", /Authorization/],
	["bearer in a sentence", "request failed with Bearer sk-live-AbCdEf0123456789xyz rejected", /request failed/],
	["basic auth", "401 Unauthorized (Authorization: Basic Zm9vOmJhcg==)", /401/],
	["query token", "GET https://api.example.com/mcp?token=hunter2pass&x=1 failed: 403", /api\.example/],
	["query api_key", "connect https://api.example.com/v1?api_key=hunter2pass", /connect/],
	["url userinfo", "ECONNREFUSED https://admin:hunter2pass@db.example.com:5432/mcp", /ECONNREFUSED/],
	["json", `{"error":"unauthorized","api_key":"hunter2pass"}`, /unauthorized/],
	["env style", "spawn failed: API_KEY=hunter2pass npx server", /spawn failed/],
	["password", "login failed password=hunter2pass user=bob", /login failed/],
	["secret in quotes", `client_secret: 'hunter2pass'`, undefined],
	["multi-line stderr tail", "\n\n  Error: boom TOKEN=hunter2pass\n    at foo (/x.js:1:1)\n    Authorization: Bearer sk-live-AbCdEf0123456789xyz", /boom/],
	["jwt", `invalid token ${JWT}`, /invalid/],
	["github token", "git clone failed ghp_16C7e42F292c6912E7710c838347Ae178B4a", /git clone/],
	["opaque hex", "mismatch 5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b", /mismatch/],
	["opaque base64", "bad value dGhpcy1pcy1hLXNlY3JldC12YWx1ZS0xMjM0NTY3ODkw", /bad value/],
	["cookie", "Cookie: session=hunter2pass; other=sk-live-AbCdEf0123456789xyz", undefined],
	["digest auth", `Authorization: Digest username="bob", response="hunter2pass"`, undefined],
	["ansi wrapped", "\x1b[31mAuthorization: Bearer sk-live-AbCdEf0123456789xyz\x1b[0m", undefined],
	["split across lines", "token:\nhunter2pass", undefined],
	["x-api-key header", "x-api-key: sk-live-AbCdEf0123456789xyz", undefined],
	["url fragment", "redirect https://a.example/cb#access_token=hunter2pass", undefined],
];

test("S13/Risk 2: no secret substring survives errorPreview, whatever the shape", () => {
	for (const [name, raw, keep] of REALISTIC) {
		const preview = errorPreview(raw);
		for (const secret of [...SECRETS, JWT, "5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b", "dGhpcy1pcy1hLXNlY3JldC12YWx1ZS0xMjM0NTY3ODkw", "AbCdEf0123456789"]) {
			assert.ok(!preview.includes(secret), `${name}: leaked ${secret} in ${JSON.stringify(preview)}`);
		}
		assert.ok(!/hunter2pass/.test(preview), `${name}: ${preview}`);
		assert.ok(!preview.includes("\x1b"), `${name}: escape code kept`);
		if (keep) assert.match(preview, keep, `${name}: useful text lost: ${preview}`);
	}
});

test("S13/Risk 2: the URL query and userinfo are cut, the rest of a short error stays readable", () => {
	assert.equal(errorPreview("401 Unauthorized"), "401 Unauthorized");
	assert.equal(errorPreview("Error: connect ECONNREFUSED"), "connect ECONNREFUSED");
	assert.ok(errorPreview("https://u:p@h.example/p?a=b").startsWith("https://h.example/p"));
	assert.ok(!errorPreview("https://u:p@h.example/p?a=b").includes("?"));
});

test("S13: the preview is one line: first meaningful line, whitespace collapsed, control characters removed", () => {
	assert.equal(errorPreview("\n\n   spawn   ENOENT\t here\n  at stack"), "spawn ENOENT here");
	assert.equal(errorPreview("\x1b[31mfailed\x1b[0m\x07\x00 now"), "failed now");
	assert.equal(errorPreview("   \n ---- \n real problem"), "real problem");
	assert.equal(errorPreview(""), "");
	assert.equal(errorPreview("    "), "");
});

test("S13: the preview fits the rail: truncated to PREVIEW_COLUMNS cells with …, wide characters count double", () => {
	const long = errorPreview("connection refused while talking to the upstream server");
	assert.equal([...long].length, PREVIEW_COLUMNS);
	assert.ok(long.endsWith("…"));
	const wide = errorPreview("接続に失敗しました。サーバーが応答しません。再試行してください");
	assert.ok(wide.endsWith("…"));
	assert.ok([...wide].length * 2 <= PREVIEW_COLUMNS + 1, wide);
});

// ---- verifier advisories: space/flag-separated secrets, input cap ----

const SEPARATED: Array<[string, string, string]> = [
	["psql flag", "psql --password hunter2 -h db", "hunter2"],
	["mysql short flag", "mysql -u root -p hunter2 db", "hunter2"],
	["mysql glued short flag", "mysql -u root -phunter2 db", "hunter2"],
	["flag token", "spawn failed --token hunter2", "hunter2"],
	["flag token equals", "spawn failed --token=hunter2", "hunter2"],
	["bare token", "token hunter2", "hunter2"],
	["invalid token", "invalid token hunter2", "hunter2"],
	["header flag", "curl -H X-Api-Key hunter2abc", "hunter2abc"],
	["bare password", "password hunter2", "hunter2"],
	["client secret", "client secret hunter2", "hunter2"],
	["api key provided", "api key provided: 0123456789abcdef", "0123456789abcdef"],
	["scheme-less userinfo", "connect user:hunter2@db.internal failed", "hunter2"],
	["cjk keyword", "密码 hunter2", "hunter2"],
	["auth flag", "run --auth hunter2", "hunter2"],
];

test("Risk 2 advisory: secrets separated by a space or a flag never survive, at any width", () => {
	for (const [name, raw, secret] of SEPARATED) {
		for (const columns of [400, PREVIEW_COLUMNS]) assert.ok(!errorPreview(raw, columns).includes(secret), `${name} @${columns}: ${errorPreview(raw, columns)}`);
	}
});

test("Risk 2 advisory: ordinary text stays readable around the new rules", () => {
	assert.equal(errorPreview("401 Unauthorized"), "401 Unauthorized");
	assert.equal(errorPreview("Unauthorized: invalid credentials page"), "Unauthorized: invalid c…");
	assert.equal(errorPreview("connect ECONNREFUSED 127.0.0.1:5432", 60), "connect ECONNREFUSED 127.0.0.1:5432");
	assert.equal(errorPreview("spawn npx ENOENT", 60), "spawn npx ENOENT");
});

test("Risk 2 advisory: pathological input is capped and finishes quickly", () => {
	for (const raw of ["a://".repeat(250_000), "x".repeat(2_000_000), "token ".repeat(300_000), "a:b@".repeat(250_000)]) {
		const started = Date.now();
		errorPreview(raw);
		assert.ok(Date.now() - started < 200, `${raw.slice(0, 8)} took ${Date.now() - started}ms`);
	}
});

test("Risk 2 advisory: parseMcpList caps a huge error too", () => {
	const started = Date.now();
	const [server] = parseMcpList(JSON.stringify({ servers: [{ name: "a", state: "failed", enabled: true, transport: "x", error: "a://".repeat(250_000) }] }))!;
	assert.ok(Date.now() - started < 200);
	assert.ok(server.preview !== undefined);
});

// ---- T11b: bare `pass` / `pw` / `pwd` ----

test("R1: bare pass, pw, pwd and env-style names are redacted at any width", () => {
	for (const raw of ["pass=hunter2", "pass: hunter2", "pw=hunter2", "pwd hunter2", "--pass hunter2", `{"pass":"hunter2"}`, "DB_PASS=hunter2", "PGPASS=hunter2", "MYSQL_PWD=hunter2", "login failed pass hunter2"]) {
		for (const columns of [400, PREVIEW_COLUMNS]) assert.ok(!errorPreview(raw, columns).includes("hunter2"), `${raw} @${columns}: ${errorPreview(raw, columns)}`);
	}
});

test("R1: ordinary words that contain `pass` stay readable", () => {
	for (const text of ["Unauthorized", "401 Unauthorized", "request passed", "password reset sent", "bypass enabled", "compass=north", "passport expired", "pass through proxy ok"]) {
		const preview = errorPreview(text, 400);
		assert.ok(!preview.includes("***") || text.startsWith("pass through"), `${text} -> ${preview}`);
	}
	assert.equal(errorPreview("password reset sent", 400), "password reset sent");
});
