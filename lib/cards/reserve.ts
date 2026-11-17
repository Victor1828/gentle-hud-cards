import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// No Pi extension API exposes `compaction.reserveTokens` (ExtensionContext has
// getContextUsage() but no settings accessor), so it is read from the settings
// files that pi-coding-agent docs/compaction.md:419 names, with the documented
// default (docs/settings.md:74, docs/compaction.md:434).
export const DEFAULT_RESERVE_TOKENS = 16_384;

export interface ReserveOptions {
	cwd?: string;
	/** `provider/modelId`, the key of `compaction.modelOverrides`. */
	model?: string;
	env?: Record<string, string | undefined>;
	home?: string;
	readFile?: (path: string) => string;
}

const validTokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readCompaction(path: string, readFile: (path: string) => string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFile(path));
		return isObject(parsed) && isObject(parsed.compaction) ? parsed.compaction : undefined;
	} catch {
		return undefined;
	}
}

/** One file's reserve: its model override, else its ordinary value; invalid values count as unset. */
function fromCompaction(compaction: Record<string, unknown> | undefined, model: string | undefined): number | undefined {
	if (!compaction) return undefined;
	const overrides = compaction.modelOverrides;
	const override = model && isObject(overrides) && isObject(overrides[model]) ? (overrides[model] as Record<string, unknown>).reserveTokens : undefined;
	if (validTokens(override)) return override;
	return validTokens(compaction.reserveTokens) ? compaction.reserveTokens : undefined;
}

/**
 * Effective reserve: project `.pi/settings.json`, then the global agent dir
 * (`PI_CODING_AGENT_DIR`, else gentle-shell's `~/.gentle-shell/agent`, else
 * `~/.pi/agent`; the first existing settings file wins), then the default.
 */
export function readReserveTokens(options: ReserveOptions = {}): number {
	const { cwd, model, env = process.env, home = homedir(), readFile = (path: string) => readFileSync(path, "utf8") } = options;
	const globalDirs = [env.PI_CODING_AGENT_DIR, join(home, ".gentle-shell", "agent"), join(home, ".pi", "agent")].filter((dir): dir is string => !!dir);
	const project = cwd ? fromCompaction(readCompaction(join(cwd, ".pi", "settings.json"), readFile), model) : undefined;
	if (project !== undefined) return project;
	for (const dir of globalDirs) {
		const compaction = readCompaction(join(dir, "settings.json"), readFile);
		if (compaction === undefined) continue;
		const value = fromCompaction(compaction, model);
		if (value !== undefined) return value;
	}
	return DEFAULT_RESERVE_TOKENS;
}
