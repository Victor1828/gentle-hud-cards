#!/usr/bin/env node
// Apply, remove, or inspect the gentle-pi rail patch. Rerun `patch` after every
// gentle-pi update: it refuses (exit 2, nothing written) when the layout changed.
// Exit codes: 0 ok, 1 gentle-pi missing, 2 refused, 3 write failed, 64 usage.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYOUT_FILE, patchLayout, railPatchStatus, unpatchLayout, type PatchReport } from "../lib/patch.ts";
import { locateGentlePi } from "../lib/locate.ts";

const USAGE = "usage: rail-patch <status|patch|unpatch> [--root <gentle-pi root>]";
const RELOAD = "Run /reload in Gentle Shell to load it.";

function fail(code: number, message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

const [operation, ...rest] = process.argv.slice(2);
if (!operation || !["status", "patch", "unpatch"].includes(operation)) fail(64, USAGE);
let root: string | undefined;
if (rest.length) {
	if (rest.length !== 2 || rest[0] !== "--root") fail(64, USAGE);
	root = rest[1];
} else {
	root = locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync });
}

let report: PatchReport;
try {
	report = operation === "patch" ? patchLayout(root) : operation === "unpatch" ? unpatchLayout(root) : railPatchStatus(root);
} catch (error) {
	// Every layout write is a rename, so a failure leaves the layout as it was.
	const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
	fail(3, `failed: ${code} writing in ${root ? dirname(join(root, LAYOUT_FILE)) : "gentle-pi"}; ${LAYOUT_FILE} was left unchanged.`);
}
const gentlePi = `gentle-pi ${report.version ?? "(unknown version)"}`;

if (report.status === "missing") fail(1, `gentle-pi not found${root ? ` at ${root}` : ""} (set GENTLE_HUD_GENTLE_PI_ROOT or pass --root).`);
if (report.status === "unknown") fail(2, `refused: ${gentlePi} changed ${LAYOUT_FILE}; the rail patch anchor was not found exactly once. Nothing was written.`);

const out = (line: string) => process.stdout.write(`${line}\n`);
if (operation === "status") out(`${report.status}: ${gentlePi} at ${report.file}`);
else if (operation === "patch") out(report.changed ? `patched: ${gentlePi} (backup: ${report.file}.gentle-hud-backup). ${RELOAD}` : `already patched: ${gentlePi}`);
else out(report.changed ? `unpatched: ${gentlePi}. ${RELOAD}` : `not patched: ${gentlePi}`);
