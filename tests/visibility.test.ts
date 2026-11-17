import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createVisibilityStore, VISIBILITY_FILE, visibilityFile } from "../lib/visibility.ts";

function scratch<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "hud-vis-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("S12: the file lives in the agent dir, resolved like the MCP card", () => {
	assert.equal(VISIBILITY_FILE, "gentle-hud-cards.json");
	assert.equal(visibilityFile({ PI_CODING_AGENT_DIR: "/a/agent" }, "/home/u"), "/a/agent/gentle-hud-cards.json");
	assert.equal(visibilityFile({}, "/home/u"), "/home/u/.pi/agent/gentle-hud-cards.json");
});

test("S12: a missing file means every card is shown, with no error", () =>
	scratch((dir) => {
		assert.deepEqual(createVisibilityStore(join(dir, VISIBILITY_FILE)).read(), { hidden: [] });
	}));

test("S12: a valid file lists the hidden cards; unknown keys are kept and read as plain strings", () =>
	scratch((dir) => {
		const file = join(dir, VISIBILITY_FILE);
		writeFileSync(file, JSON.stringify({ version: 1, hidden: ["hud-mcp", "hud-future"] }));
		assert.deepEqual(createVisibilityStore(file).read(), { hidden: ["hud-mcp", "hud-future"] });
	}));

test("S12: invalid files read as all shown with an error, and are not rewritten by reading", () =>
	scratch((dir) => {
		const file = join(dir, VISIBILITY_FILE);
		const store = createVisibilityStore(file);
		for (const content of ["{nope", "[]", "null", JSON.stringify({ version: 2, hidden: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, hidden: "hud-mcp" }), JSON.stringify({ version: 1, hidden: [1] })]) {
			writeFileSync(file, content);
			const result = store.read();
			assert.deepEqual(result.hidden, [], content);
			assert.match(result.error ?? "", /gentle-hud-cards\.json/, content);
			assert.equal(readFileSync(file, "utf8"), content, "reading never overwrites");
		}
	}));

test("S12: an unreadable file (a directory) reads as all shown with the error code", () =>
	scratch((dir) => {
		const file = join(dir, VISIBILITY_FILE);
		mkdirSync(file);
		const result = createVisibilityStore(file).read();
		assert.deepEqual(result.hidden, []);
		assert.match(result.error ?? "", /EISDIR/);
	}));

test("S12: write creates the directory, writes the versioned schema, and leaves no temp file", () =>
	scratch((dir) => {
		const file = join(dir, "nested", "agent", VISIBILITY_FILE);
		const store = createVisibilityStore(file);
		store.write(["hud-mcp"]);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, hidden: ["hud-mcp"] });
		assert.deepEqual(readdirSync(join(dir, "nested", "agent")), [VISIBILITY_FILE]);
		store.write([]);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, hidden: [] });
		assert.deepEqual(store.read(), { hidden: [] });
	}));

test("S12: write goes through a temp file and a rename, never straight into the target", () =>
	scratch((dir) => {
		const file = join(dir, VISIBILITY_FILE);
		const calls: string[] = [];
		const fs = {
			...nodeFs,
			writeFileSync: (path: string, data: string) => (calls.push(`write ${path === file ? "TARGET" : "temp"}`), nodeFs.writeFileSync(path, data)),
			renameSync: (from: string, to: string) => (calls.push(`rename ${to === file ? "TARGET" : "other"}`), nodeFs.renameSync(from, to)),
		};
		createVisibilityStore(file, fs).write(["hud-tools"]);
		assert.deepEqual(calls, ["write temp", "rename TARGET"]);
	}));

test("S12: a failed write throws, keeps the previous file intact, and leaves no temp file", () =>
	scratch((dir) => {
		const file = join(dir, VISIBILITY_FILE);
		writeFileSync(file, JSON.stringify({ version: 1, hidden: ["hud-mcp"] }));
		const fs = {
			...nodeFs,
			renameSync: () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		};
		assert.throws(() => createVisibilityStore(file, fs).write([]), /denied/);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, hidden: ["hud-mcp"] });
		assert.deepEqual(readdirSync(dir), [VISIBILITY_FILE]);
	}));
