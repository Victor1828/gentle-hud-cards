import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The rail patch: gentle-pi's fullscreen rail draws a hard-coded section list.
// One exact line gains the hud-* sidebar parts between "agents" and "footer".
// The patch is applied only when the anchor is proven (exactly once, followed
// by the code that reads the parts), never by fuzzy matching (S4).

export const LAYOUT_FILE = join("lib", "shell-sidebar-layout.ts");
export const ANCHOR = 'const sections = ["todo", "jobs", "agents", "footer"].filter(';
export const MARKER = "/* gentle-hud-cards:rail-patch v1 */";
// The try/catch keeps the rail drawing (without hud sections) if a future
// gentle-pi keeps the anchor but renames `state`.
export const PATCHED = `${MARKER} const sections = ["todo", "jobs", "agents", ...(() => { try { return [...state.parts.keys()].filter((key) => key.startsWith("hud-")); } catch { return []; } })(), "footer"].filter(`;
export const BACKUP_SUFFIX = ".gentle-hud-backup";
const CONTEXT = "state.parts.get(key)";
const CONTEXT_WINDOW = 400;

export type PatchStatus = "patched" | "unpatched" | "unknown" | "missing";

const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

/** The single occurrence is code: only indentation before it on its line, the parts lookup right after. */
function provenAt(source: string, needle: string): boolean {
	const start = source.indexOf(needle);
	const lineStart = source.lastIndexOf("\n", start - 1) + 1;
	const end = start + needle.length;
	return /^[ \t]*$/.test(source.slice(lineStart, start)) && source.slice(end, end + CONTEXT_WINDOW).includes(CONTEXT);
}

/** Classify a layout source; anything not provably patched or unpatched is "unknown". */
export function inspectLayout(source: string): Exclude<PatchStatus, "missing"> {
	const anchors = occurrences(source, ANCHOR);
	const patches = occurrences(source, PATCHED);
	if (anchors === 1 && patches === 0 && provenAt(source, ANCHOR)) return "unpatched";
	if (patches === 1 && anchors === 0 && provenAt(source, PATCHED)) return "patched";
	return "unknown";
}

/** The patched source when `source` is provably unpatched, else no source. */
export function patchSource(source: string): { status: Exclude<PatchStatus, "missing">; source?: string } {
	const status = inspectLayout(source);
	return status === "unpatched" ? { status, source: source.replace(ANCHOR, PATCHED) } : { status };
}

/** The original source when `source` is provably patched, else no source. */
export function unpatchSource(source: string): { status: Exclude<PatchStatus, "missing">; source?: string } {
	const status = inspectLayout(source);
	return status === "patched" ? { status, source: source.replace(PATCHED, ANCHOR) } : { status };
}

export interface PatchReport {
	status: PatchStatus;
	/** True only when this call wrote the layout file. */
	changed: boolean;
	version: string | undefined;
	file: string | undefined;
}

function gentlePiVersion(root: string): string | undefined {
	try {
		const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

function readLayout(root: string | undefined): { report: PatchReport; source?: string } {
	if (!root) return { report: { status: "missing", changed: false, version: undefined, file: undefined } };
	const file = join(root, LAYOUT_FILE);
	const version = gentlePiVersion(root);
	if (!existsSync(file)) return { report: { status: "missing", changed: false, version, file } };
	const source = readFileSync(file, "utf8");
	return { report: { status: inspectLayout(source), changed: false, version, file }, source };
}

/** Write through a sibling temp file and rename, keeping the original mode. */
function writeAtomic(file: string, content: string, mode: number): void {
	const temp = `${file}.gentle-hud-tmp`;
	writeFileSync(temp, content, { mode });
	chmodSync(temp, mode);
	renameSync(temp, file);
}

export function railPatchStatus(root: string | undefined): PatchReport {
	return readLayout(root).report;
}

export function patchLayout(root: string | undefined): PatchReport {
	const { report, source } = readLayout(root);
	if (report.status !== "unpatched" || source === undefined || !report.file) return report;
	const mode = statSync(report.file).mode & 0o777;
	writeAtomic(report.file + BACKUP_SUFFIX, source, mode);
	writeAtomic(report.file, patchSource(source).source!, mode);
	return { ...report, status: "patched", changed: true };
}

export function unpatchLayout(root: string | undefined): PatchReport {
	const { report, source } = readLayout(root);
	if (report.status !== "patched" || source === undefined || !report.file) return report;
	const restored = unpatchSource(source).source!;
	writeAtomic(report.file, restored, statSync(report.file).mode & 0o777);
	const backup = report.file + BACKUP_SUFFIX;
	// A backup that no longer matches (gentle-pi changed under the patch) is kept for the user.
	try {
		if (existsSync(backup) && readFileSync(backup, "utf8") === restored) rmSync(backup);
	} catch {
		// The layout is already restored; a leftover backup is harmless.
	}
	return { ...report, status: "unpatched", changed: true };
}
