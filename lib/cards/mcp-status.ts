import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { truncate } from "../card.ts";

// MCP live status (T11, S13): runs Pi's own `pi mcp list --json`
// (pi-coding-agent dist/extensions/mcp/cli.js, reached from dist/main.js
// `args[0] === "mcp"`) as a child process and keeps ONLY name, state, a
// transport kind, enabled, and a redacted one-line error preview.
//
// The CLI's `transport` is the raw URL or command line, and `error` can carry
// stderr and URLs, so both are reduced the moment they are parsed; nothing
// raw is kept, logged, or notified.

export type McpState = string; // connecting | connected | disconnected | needs-auth | failed | closed | disabled

export interface McpServerStatus {
	name: string;
	state: McpState;
	/** http for a URL, stdio for a command line; the raw value is dropped. */
	transport: "http" | "stdio";
	enabled: boolean;
	/** One redacted line, at most PREVIEW_COLUMNS cells; absent when the server reported no error. */
	preview?: string;
}

/** Cells for an error preview: the rail's body row is ~28 cells and the preview row is indented by 2. */
export const PREVIEW_COLUMNS = 24;

// ---- redaction ----

const PLACEHOLDER = "***";
// Control characters (C0, DEL, C1), after ANSI sequences were removed.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const SENSITIVE_KEY = /token|key|secret|passw|pwd|credential|signature|session|(?<![a-z])(?:pg|mysql|db|redis)?(?:pass|pw|pwd)(?![a-z])|(?<![a-z])auth(?:orization|entication)?(?![a-z])/i;

/** Only the first meaningful line is ever shown, so redaction never needs more than this; it also bounds the regex work. */
export const MAX_ERROR_INPUT = 4096;

/** ANSI sequences and control characters removed (server names and error text). */
export const stripControl = (text: string) => text.replace(ANSI_SEQUENCE, "").replace(CONTROL, "");

// Words that follow a secret word in ordinary prose ("password reset sent"); they are not values.
const PROSE = "(?:reset|expired|required|incorrect|invalid|missing|rejected|mismatch|failed|error|not|has|must|too|for|and|or|sent|changed?|authentication|through)";

const SECRET_WORD = "(?:--?[\\w-]*(?:pass|token|secret|key|auth)[\\w-]*|passw(?:or)?d|pwd|pw|pass|token|api[-_ ]?key|secret|密码|口令|密钥|令牌)";

/** Remove every credential-shaped substring from `text`. Order matters: wide patterns first. */
export function redact(text: string): string {
	return (
		text
			// URL userinfo (`user:pass@host`), then query string and fragment.
			.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1")
			.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1")
			// Header lines whose whole value is a credential, whatever its scheme.
			.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)(["']?\s*[:=]\s*)[^\n]*/gi, `$1$2${PLACEHOLDER}`)
			.replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, `$1 ${PLACEHOLDER}`)
			// JWT-like and well-known token prefixes.
			.replace(/\beyJ[\w-]*\.[\w-]+(?:\.[\w-]*)?/g, PLACEHOLDER)
			.replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|glpat|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}/g, PLACEHOLDER)
			// A secret word followed by its value after a space, `=` or `:` (`--password x`, `token x`, `api key provided: x`).
			// Over-redacts the word after "token"/"secret"/"password" in prose; that is the safe side.
			.replace(new RegExp(`(?<![A-Za-z])(${SECRET_WORD})((?:\\s*[:=]\\s*|\\s+)(?:(?:provided|is|was|value|given)\\s*[:=]?\\s*)*)(?!${PROSE}\\b)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`, "gi"), `$1$2${PLACEHOLDER}`)
			// Short password flags after well-known DB clients: `-p x` and `-px` (psql's `-p` is a port; over-redacted on purpose).
			.replace(/(\b(?:psql|mysql|mysqldump|mariadb|mongosh?|redis-cli|pg_dump|pg_restore|sqlcmd)\b[^\n]*?\s)-p\s*[^\s-][^\s]*/gi, `$1-p ${PLACEHOLDER}`)
			// Scheme-less userinfo `user:pass@host`.
			.replace(/\b[\w.+-]+:[^\s@/:]+@/g, `${PLACEHOLDER}@`)
			// `key=value`, `"key": "value"`, `KEY: value` for sensitive key names.
			.replace(/([\w.-]{1,64})(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/g, (match, key: string, sep: string) => (SENSITIVE_KEY.test(key) ? `${key}${sep}${PLACEHOLDER}` : match))
			// Long opaque runs (base64, hex, ids): 20+ chars mixing letters with digits, or upper with lower case.
			.replace(/[A-Za-z0-9+/_=-]{20,}/g, (run) => {
				const letters = /[A-Za-z]/.test(run);
				const digits = /\d/.test(run);
				const mixed = /[a-z]/.test(run) && /[A-Z]/.test(run);
				return (letters && digits) || mixed || (!letters && digits && run.length >= 20) ? PLACEHOLDER : run;
			})
	);
}

/**
 * One safe line for the rail: control codes removed, credentials redacted,
 * first meaningful line, whitespace collapsed, then cut to PREVIEW_COLUMNS.
 * Redaction runs on the whole text first so a secret split over lines is seen.
 */
export function errorPreview(raw: string, columns = PREVIEW_COLUMNS): string {
	const clean = redact(stripControl(raw.slice(0, MAX_ERROR_INPUT)));
	const lines = clean.split(/\r?\n|\r/).map((line) => line.replace(/\s+/g, " ").trim());
	const line = lines.find((candidate) => /[\p{L}\p{N}]/u.test(candidate.replaceAll(PLACEHOLDER, ""))) ?? "";
	// "Error: connect ECONNREFUSED" reads better without the prefix and wastes 7 cells.
	const body = line.replace(/^(?:[A-Za-z]*Error|Error):\s+(?=\S)/, "");
	return truncate(body, columns);
}

// ---- parsing ----

type Entry = Record<string, unknown>;
const isObject = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);

/** `pi mcp list --json` stdout to the kept fields; undefined when it is not a servers list. */
export function parseMcpList(stdout: string): McpServerStatus[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || !Array.isArray(parsed.servers)) return undefined;
	const servers: McpServerStatus[] = [];
	for (const entry of parsed.servers) {
		if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.state !== "string") continue;
		const server: McpServerStatus = {
			name: stripControl(entry.name),
			state: entry.state,
			transport: typeof entry.transport === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.transport) ? "http" : "stdio",
			enabled: entry.enabled !== false,
		};
		if (typeof entry.error === "string") {
			const preview = errorPreview(entry.error);
			if (preview) server.preview = preview;
		}
		servers.push(server);
	}
	return servers;
}

// ---- runner ----

export interface RunPiMcpListOptions {
	/** The pi-coding-agent CLI entry (its package `bin.pi`), launched with `execPath`. */
	cliPath: string;
	cwd: string;
	/** Inherited by default, so PI_CODING_AGENT_DIR matches the session. */
	env?: NodeJS.ProcessEnv;
	execPath?: string;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}

export const MCP_STATUS_TIMEOUT_MS = 20_000;
export const MCP_STATUS_MAX_BYTES = 2_000_000;

function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
	try {
		// The child leads its own process group (detached), so one signal reaches the MCP servers it started.
		if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/**
 * Run `pi mcp list --json` once. stdin is closed (nothing can prompt), stderr
 * is discarded, stdout is size-capped, and the whole process tree is killed on
 * timeout or abort. Pi exits 1 when any server failed but still prints the JSON,
 * so a non-zero exit with a valid list is a result. Never logs raw output.
 */
export function runPiMcpList(options: RunPiMcpListOptions): Promise<McpServerStatus[]> {
	const { cliPath, cwd, env = process.env, execPath = process.execPath, timeoutMs = MCP_STATUS_TIMEOUT_MS, maxBytes = MCP_STATUS_MAX_BYTES, signal } = options;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(execPath, [cliPath, "mcp", "list", "--json"], { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
		} catch (error) {
			return reject(error);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const fail = (message: string) =>
			finish(() => {
				killTree(child);
				reject(new Error(message));
			});
		const onAbort = () => fail("aborted");
		const timer = setTimeout(() => fail("timed out"), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.unref();
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) return fail("output too large");
			chunks.push(chunk);
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", () =>
			finish(() => {
				// The process group can outlive the CLI (stdio servers); close it out.
				killTree(child);
				const servers = parseMcpList(Buffer.concat(chunks).toString("utf8"));
				if (servers) resolve(servers);
				else reject(new Error("invalid output"));
			}),
		);
	});
}

/** The CLI entry of the Pi that gentle-pi ships: its package `bin.pi`, nested under gentle-pi or hoisted next to it. */
export function resolvePiCli(gentlePiRoot: string | undefined, readFile: (path: string) => string): string | undefined {
	if (!gentlePiRoot) return undefined;
	const packages = [join(gentlePiRoot, "node_modules", "@earendil-works", "pi-coding-agent"), join(dirname(gentlePiRoot), "@earendil-works", "pi-coding-agent")];
	for (const dir of packages) {
		try {
			const bin = (JSON.parse(readFile(join(dir, "package.json"))) as { bin?: unknown }).bin;
			const entry = typeof bin === "string" ? bin : isObject(bin) && typeof bin.pi === "string" ? bin.pi : undefined;
			if (entry) return join(dir, entry);
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}
