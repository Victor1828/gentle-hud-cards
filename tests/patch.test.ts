import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANCHOR, BACKUP_SUFFIX, inspectLayout, LAYOUT_FILE, MARKER, patchLayout, patchSource, railPatchStatus, unpatchLayout, unpatchSource } from "../lib/patch.ts";

// Shape of gentle-pi 4.8.0 lib/shell-sidebar-layout.ts around the anchor.
const UNPATCHED = [
	"function prepare(state) {",
	"\t\t\t// Live work first, then the session Status sections.",
	`\t\t\t${ANCHOR}(key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {`,
	"\t\t\t\tconst component = state.parts.get(key);",
	"\t\t\t});",
	"}",
	"",
].join("\n");

/** `source: null` leaves the layout file out. */
function fakeGentlePi(source: string | null = UNPATCHED, version = "4.8.0") {
	const root = mkdtempSync(join(tmpdir(), "hud-patch-"));
	mkdirSync(join(root, "lib"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gentle-pi", version }));
	if (source !== null) writeFileSync(join(root, LAYOUT_FILE), source);
	return { root, file: join(root, LAYOUT_FILE), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("patchSource rewrites only the anchor line, keeps the line count, and marks it", () => {
	const result = patchSource(UNPATCHED);
	assert.equal(result.status, "unpatched");
	const patched = result.source!;
	const before = UNPATCHED.split("\n");
	const after = patched.split("\n");
	assert.equal(after.length, before.length);
	assert.deepEqual(after.filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), "only the anchor line changes");
	assert.ok(after[2].startsWith(`\t\t\t${MARKER} `));
	assert.ok(after[2].includes('"agents", ...'), "hud sections go after agents");
	assert.ok(after[2].includes('"footer"].filter('), "footer stays last");
	assert.ok(after[2].includes('key.startsWith("hud-")'));
	assert.ok(after[2].includes("try {") && after[2].includes("catch"), "a renamed state degrades to no hud sections");
	assert.equal(inspectLayout(patched), "patched");
});

test("the injected expression evaluates to the hud-* keys in insertion order, and to [] when state is gone", () => {
	const line = patchSource(UNPATCHED).source!.split("\n")[2];
	const list = line.slice(line.indexOf("["), line.lastIndexOf("].filter(") + 1);
	const evaluate = new Function("state", `return ${list};`);
	const state = { parts: new Map([["todo", 1], ["hud-b", 1], ["agents", 1], ["hud-a", 1], ["footer", 1]]) };
	assert.deepEqual(evaluate(state), ["todo", "jobs", "agents", "hud-b", "hud-a", "footer"]);
	assert.deepEqual(new Function(`return ${list};`)(), ["todo", "jobs", "agents", "footer"], "ReferenceError on state is swallowed");
});

test("unpatchSource restores the exact original bytes", () => {
	const patched = patchSource(UNPATCHED).source!;
	const result = unpatchSource(patched);
	assert.equal(result.status, "patched");
	assert.equal(result.source, UNPATCHED);
});

test("inspectLayout refuses anything it cannot prove: missing, duplicated, or context-less anchors", () => {
	assert.equal(inspectLayout(UNPATCHED), "unpatched");
	assert.equal(inspectLayout(UNPATCHED.replace(ANCHOR, 'const sections = ["todo", "jobs", "agents", "stats", "footer"].filter(')), "unknown");
	assert.equal(inspectLayout(UNPATCHED + UNPATCHED), "unknown");
	assert.equal(inspectLayout(UNPATCHED.replace("state.parts.get(key)", "registry.get(key)")), "unknown");
	const patched = patchSource(UNPATCHED).source!;
	assert.equal(inspectLayout(patched + UNPATCHED), "unknown", "patched and unpatched at once");
	assert.equal(patchSource(UNPATCHED + UNPATCHED).source, undefined);
	assert.equal(unpatchSource(UNPATCHED).source, undefined);
});

test("patchLayout patches once, backs up the original, preserves the mode, and is idempotent", () => {
	const gp = fakeGentlePi();
	try {
		chmodSync(gp.file, 0o640);
		const first = patchLayout(gp.root);
		assert.deepEqual(first, { status: "patched", changed: true, version: "4.8.0", file: gp.file });
		assert.equal(readFileSync(gp.file + BACKUP_SUFFIX, "utf8"), UNPATCHED);
		assert.equal(statSync(gp.file).mode & 0o777, 0o640);
		const bytes = readFileSync(gp.file, "utf8");
		const second = patchLayout(gp.root);
		assert.deepEqual(second, { status: "patched", changed: false, version: "4.8.0", file: gp.file });
		assert.equal(readFileSync(gp.file, "utf8"), bytes, "a second patch writes nothing");
		assert.equal(railPatchStatus(gp.root).status, "patched");
	} finally {
		gp.cleanup();
	}
});

test("unpatchLayout restores the original, removes the matching backup, and is idempotent", () => {
	const gp = fakeGentlePi();
	try {
		patchLayout(gp.root);
		assert.deepEqual(unpatchLayout(gp.root), { status: "unpatched", changed: true, version: "4.8.0", file: gp.file });
		assert.equal(readFileSync(gp.file, "utf8"), UNPATCHED);
		assert.equal(existsSync(gp.file + BACKUP_SUFFIX), false);
		assert.deepEqual(unpatchLayout(gp.root), { status: "unpatched", changed: false, version: "4.8.0", file: gp.file });
		assert.equal(readFileSync(gp.file, "utf8"), UNPATCHED);
	} finally {
		gp.cleanup();
	}
});

test("an unknown layout is refused and left byte-identical, with no backup", () => {
	const changed = UNPATCHED.replace(ANCHOR, 'const sections = ["todo", "jobs", "agents", "stats", "footer"].filter(');
	const gp = fakeGentlePi(changed, "4.9.0");
	try {
		assert.deepEqual(patchLayout(gp.root), { status: "unknown", changed: false, version: "4.9.0", file: gp.file });
		assert.deepEqual(unpatchLayout(gp.root), { status: "unknown", changed: false, version: "4.9.0", file: gp.file });
		assert.equal(readFileSync(gp.file, "utf8"), changed);
		assert.equal(existsSync(gp.file + BACKUP_SUFFIX), false);
	} finally {
		gp.cleanup();
	}
});

test("a gentle-pi without the layout file reports missing and writes nothing", () => {
	const gp = fakeGentlePi(null);
	try {
		assert.equal(railPatchStatus(gp.root).status, "missing");
		assert.equal(patchLayout(gp.root).status, "missing");
		assert.equal(existsSync(gp.file), false);
		assert.equal(railPatchStatus(undefined).status, "missing");
	} finally {
		gp.cleanup();
	}
});
