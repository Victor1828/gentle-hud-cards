import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { mcpAgentDir } from "./cards/mcp.ts";

/** Which HUD cards the user hid with `/hud`: `<agentDir>/gentle-hud-cards.json`, `{"version":1,"hidden":["hud-mcp"]}`. */
export const VISIBILITY_FILE = "gentle-hud-cards.json";
const VERSION = 1;

/** Same agent dir as the MCP card: PI_CODING_AGENT_DIR, else ~/.pi/agent (Gentle Shell sets ~/.gentle-shell/agent). */
export function visibilityFile(env: Record<string, string | undefined>, home: string): string {
	return join(mcpAgentDir(env, home), VISIBILITY_FILE);
}

/** The fs slice the store uses; tests inject a temp dir or a failing fs. */
export interface VisibilityFs {
	readFileSync(file: string, encoding: "utf8"): string;
	writeFileSync(file: string, data: string): void;
	renameSync(from: string, to: string): void;
	mkdirSync(dir: string, options: { recursive: true }): unknown;
	rmSync(file: string, options: { force: true }): void;
}

export interface VisibilityRead {
	/** Hidden card keys, exactly as stored (unknown keys included; callers ignore them). */
	hidden: string[];
	/** Set when the file exists but cannot be used; `hidden` is then empty (every card shown). */
	error?: string;
}

export interface VisibilityStore {
	read(): VisibilityRead;
	/** Atomic: temp file + rename, creating the directory. Throws when the write fails. */
	write(hidden: string[]): void;
}

export function createVisibilityStore(file: string, fs: VisibilityFs = nodeFs): VisibilityStore {
	const invalid = (reason: string): VisibilityRead => ({ hidden: [], error: `gentle-hud-cards: ${file} ${reason}; showing every card. Change a card with /hud to replace it.` });
	return {
		read() {
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") return { hidden: [] };
				return invalid(`could not be read (${code ?? "unknown error"})`);
			}
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				return invalid("is not valid JSON");
			}
			const record = data as { version?: unknown; hidden?: unknown } | null;
			if (typeof record !== "object" || record === null || Array.isArray(record) || record.version !== VERSION) return invalid(`is not a version ${VERSION} visibility file`);
			if (!Array.isArray(record.hidden) || !record.hidden.every((entry) => typeof entry === "string")) return invalid('has no "hidden" list of card keys');
			return { hidden: [...(record.hidden as string[])] };
		},
		write(hidden) {
			const temp = `${file}.gentle-hud-tmp`;
			try {
				fs.mkdirSync(dirname(file), { recursive: true });
				fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, hidden }, null, 2)}\n`);
				fs.renameSync(temp, file);
			} catch (error) {
				try {
					fs.rmSync(temp, { force: true });
				} catch {
					// Best effort: the original error is the one to report.
				}
				throw error;
			}
		},
	};
}

/** A store that never touches disk (used when none is injected). */
export function createMemoryVisibilityStore(): VisibilityStore {
	let hidden: string[] = [];
	return { read: () => ({ hidden: [...hidden] }), write: (next) => void (hidden = [...next]) };
}
