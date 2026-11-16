import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANCHOR, BACKUP_SUFFIX, LAYOUT_FILE } from "../lib/patch.ts";

const CLI = join(import.meta.dirname, "..", "bin", "rail-patch.ts");
const SOURCE = `\t\t\t${ANCHOR}(key) => true).map((key) => {\n\t\t\t\tconst component = state.parts.get(key);\n`;

function run(...args: string[]) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { encoding: "utf8" });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withGentlePi(source: string | null, body: (root: string, file: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "hud-cli-"));
	try {
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "4.8.0" }));
		if (source !== null) writeFileSync(join(root, LAYOUT_FILE), source);
		body(root, join(root, LAYOUT_FILE));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("status, patch, re-patch, unpatch, re-unpatch: exact output and exit codes", () => {
	withGentlePi(SOURCE, (root, file) => {
		assert.deepEqual(run("status", "--root", root), { code: 0, stdout: `unpatched: gentle-pi 4.8.0 at ${file}\n`, stderr: "" });
		assert.deepEqual(run("patch", "--root", root), { code: 0, stdout: `patched: gentle-pi 4.8.0 (backup: ${file}${BACKUP_SUFFIX}). Run /reload in Gentle Shell to load it.\n`, stderr: "" });
		assert.deepEqual(run("status", "--root", root), { code: 0, stdout: `patched: gentle-pi 4.8.0 at ${file}\n`, stderr: "" });
		assert.deepEqual(run("patch", "--root", root), { code: 0, stdout: "already patched: gentle-pi 4.8.0\n", stderr: "" });
		assert.deepEqual(run("unpatch", "--root", root), { code: 0, stdout: "unpatched: gentle-pi 4.8.0. Run /reload in Gentle Shell to load it.\n", stderr: "" });
		assert.deepEqual(run("unpatch", "--root", root), { code: 0, stdout: "not patched: gentle-pi 4.8.0\n", stderr: "" });
		assert.equal(readFileSync(file, "utf8"), SOURCE);
	});
});

test("an unknown layout is refused with exit 2 and left untouched", () => {
	const changed = SOURCE.replace('"agents", "footer"', '"agents", "stats", "footer"');
	withGentlePi(changed, (root, file) => {
		const refusal = `refused: gentle-pi 4.8.0 changed ${LAYOUT_FILE}; the rail patch anchor was not found exactly once. Nothing was written.\n`;
		assert.deepEqual(run("status", "--root", root), { code: 2, stdout: "", stderr: refusal });
		assert.deepEqual(run("patch", "--root", root), { code: 2, stdout: "", stderr: refusal });
		assert.deepEqual(run("unpatch", "--root", root), { code: 2, stdout: "", stderr: refusal });
		assert.equal(readFileSync(file, "utf8"), changed);
		assert.equal(existsSync(file + BACKUP_SUFFIX), false);
	});
});

test("a write failure exits 3 with one line and leaves the layout unchanged", (t) => {
	if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
	withGentlePi(SOURCE, (root, file) => {
		const lib = join(root, "lib");
		chmodSync(lib, 0o555);
		try {
			assert.deepEqual(run("patch", "--root", root), { code: 3, stdout: "", stderr: `failed: EACCES writing in ${lib}; ${LAYOUT_FILE} was left unchanged.\n` });
			assert.equal(readFileSync(file, "utf8"), SOURCE);
			assert.equal(existsSync(file + BACKUP_SUFFIX), false);
		} finally {
			chmodSync(lib, 0o755);
		}
	});
});

test("a missing layout exits 1; bad usage exits 64 without touching anything", () => {
	withGentlePi(null, (root) => {
		const missing = `gentle-pi not found at ${root} (set GENTLE_HUD_GENTLE_PI_ROOT or pass --root).\n`;
		assert.deepEqual(run("status", "--root", root), { code: 1, stdout: "", stderr: missing });
		assert.deepEqual(run("patch", "--root", root), { code: 1, stdout: "", stderr: missing });
	});
	const usage = "usage: rail-patch <status|patch|unpatch> [--root <gentle-pi root>]\n";
	assert.deepEqual(run(), { code: 64, stdout: "", stderr: usage });
	assert.deepEqual(run("explode"), { code: 64, stdout: "", stderr: usage });
	assert.deepEqual(run("patch", "--root"), { code: 64, stdout: "", stderr: usage });
});
