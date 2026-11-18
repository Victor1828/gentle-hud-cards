import { join } from "node:path";
import type { HudCard } from "../card.ts";
import { stripControl, type McpServerStatus } from "./mcp-status.ts";

// MCP card (T6): the servers Pi's built-in MCP extension loads, from the same
// files and with the same merge rule (pi-coding-agent extensions/mcp/config.js):
// `<agentDir>/mcp.json`, then `<cwd>/.pi/mcp.json` only when the project is
// trusted. A project entry with the same name replaces the global one; a project
// entry with no command/url/type only overrides `enabled`. Live connection state
// is private to Pi's MCP extension; the live view (T11, S13) comes from the
// `pi mcp list --json` CLI (mcp-status.ts) and failing tool calls (mcp-live.ts).
// Only names, transport, and enabled are kept: env, headers, args and urls
// carry secrets and never leave this reader.

/** Server rows shown before `+N more`. */
export const MAX_SERVER_ROWS = 8;

export type McpTransport = "stdio" | "http" | "invalid";

export interface McpServerInfo {
	name: string;
	transport: McpTransport;
	enabled: boolean;
	source: "global" | "project";
}

export interface McpConfigResult {
	servers: McpServerInfo[];
	/** One short line per file that could not be used, e.g. `project mcp.json invalid`. */
	errors: string[];
	/** The project has a `.pi/mcp.json`, but it is not trusted, so Pi ignores it. */
	projectIgnored: boolean;
}

export interface ReadMcpOptions {
	agentDir: string;
	cwd?: string;
	projectTrusted: boolean;
	readFile(path: string): string;
	exists(path: string): boolean;
}

/** Pi's getAgentDir(): `PI_CODING_AGENT_DIR` (Gentle Shell sets it to ~/.gentle-shell/agent), else ~/.pi/agent. */
export function mcpAgentDir(env: Record<string, string | undefined>, home: string): string {
	return env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
}

type Entry = Record<string, unknown>;
const isObject = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);

function transportOf(entry: Entry): McpTransport {
	if (entry.type === "sse") return "invalid"; // Pi rejects SSE.
	if (typeof entry.url === "string" && (entry.type === undefined || entry.type === "http" || entry.type === "streamable-http")) return "http";
	if (typeof entry.command === "string" && (entry.type === undefined || entry.type === "stdio")) return "stdio";
	return "invalid";
}

const isOverrideOnly = (entry: Entry) => entry.command === undefined && entry.url === undefined && entry.type === undefined;

/** The `mcpServers` object of one file; undefined when absent; an error line when unusable. */
function readServers(path: string, label: string, options: ReadMcpOptions, errors: string[]): Entry | undefined {
	let text: string;
	try {
		text = options.readFile(path);
	} catch (error) {
		if ((error as { code?: unknown })?.code !== "ENOENT") errors.push(`${label} mcp.json unreadable`);
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) throw new Error("not an object");
		if (parsed.mcpServers === undefined) return undefined;
		if (!isObject(parsed.mcpServers)) throw new Error("mcpServers is not an object");
		return parsed.mcpServers;
	} catch {
		errors.push(`${label} mcp.json invalid`);
		return undefined;
	}
}

function serverInfo(name: string, entry: unknown, source: McpServerInfo["source"]): McpServerInfo {
	name = stripControl(name);
	if (!isObject(entry)) return { name, transport: "invalid", enabled: false, source };
	return { name, transport: transportOf(entry), enabled: entry.enabled !== false, source };
}

export function readMcpConfig(options: ReadMcpOptions): McpConfigResult {
	const errors: string[] = [];
	const servers = new Map<string, McpServerInfo>();
	for (const [name, entry] of Object.entries(readServers(join(options.agentDir, "mcp.json"), "global", options, errors) ?? {})) {
		servers.set(name, serverInfo(name, entry, "global"));
	}

	let projectIgnored = false;
	if (options.cwd) {
		const projectPath = join(options.cwd, ".pi", "mcp.json");
		if (!options.projectTrusted) {
			projectIgnored = options.exists(projectPath);
		} else {
			for (const [name, entry] of Object.entries(readServers(projectPath, "project", options, errors) ?? {})) {
				const base = servers.get(name);
				if (isObject(entry) && isOverrideOnly(entry)) {
					// An override without a global server to apply to has nothing to start.
					if (base && typeof entry.enabled === "boolean") servers.set(name, { ...base, enabled: entry.enabled });
					continue;
				}
				servers.set(name, serverInfo(name, entry, "project"));
			}
		}
	}
	return { servers: [...servers.values()], errors, projectIgnored };
}

function serverRow(server: McpServerInfo): string {
	if (server.transport === "invalid") return `✕ ${server.name} · invalid`;
	if (!server.enabled) return `○ ${server.name} · off`;
	return `● ${server.name} · ${server.transport}`;
}

/**
 * Live view merged into the card (S13): the `pi mcp list --json` result by
 * server name and the latest failing tool call per server. Only short redacted
 * previews are held here, never raw error text.
 */
export interface McpLiveView {
	/** `checking`: the CLI is running; `done`: it answered; `unavailable`: it did not (timeout, crash, bad JSON). */
	check: "checking" | "done" | "unavailable";
	status: ReadonlyMap<string, McpServerStatus>;
	liveErrors: ReadonlyMap<string, string>;
}

type Health = { kind: "ok" } | { kind: "bad"; label: string; preview?: string } | { kind: "pending"; label: string } | { kind: "plain" };

const BAD_LABEL: Record<string, string> = { failed: "failed", "needs-auth": "needs auth", disconnected: "offline", closed: "offline", connecting: "offline" };

function healthOf(server: McpServerInfo, live: McpLiveView): Health {
	const liveError = live.liveErrors.get(server.name);
	const status = live.status.get(server.name);
	if (status) {
		if (status.state === "connected") return liveError ? { kind: "bad", label: "failed", preview: liveError } : { kind: "ok" };
		const label = BAD_LABEL[status.state];
		if (label) return { kind: "bad", label, preview: liveError ?? status.preview };
	}
	if (liveError) return { kind: "bad", label: "failed", preview: liveError };
	if (live.check === "checking") return { kind: "pending", label: "checking" };
	if (live.check === "unavailable") return { kind: "plain" };
	return { kind: "pending", label: "unchecked" };
}

export function mcpCard(result: McpConfigResult, live?: McpLiveView): HudCard {
	const { servers, errors, projectIgnored } = result;
	const usable = servers.filter((server) => server.enabled && server.transport !== "invalid");
	const health = new Map(usable.map((server) => [server, live ? healthOf(server, live) : ({ kind: "plain" } as Health)]));
	const isBad = (server: McpServerInfo) => health.get(server)?.kind === "bad";
	// Red servers first, so neither the row cap nor `+N more` can hide a problem.
	const ordered = [...servers.filter(isBad), ...servers.filter((server) => !isBad(server))];
	const redCount = ordered.filter(isBad).length;
	const shown = servers.length === 0 ? [] : ordered.slice(0, Math.max(MAX_SERVER_ROWS, redCount));
	const body: string[] = servers.length === 0 ? ["No servers configured"] : [];
	const glyphRoles: Array<string | undefined> = body.map(() => undefined);
	for (const server of shown) {
		const h = health.get(server);
		if (!h || h.kind === "plain") {
			body.push(serverRow(server));
			glyphRoles.push(undefined);
		} else if (h.kind === "ok") {
			body.push(`● ${server.name} · ${server.transport}`);
			glyphRoles.push("success");
		} else if (h.kind === "pending") {
			body.push(`● ${server.name} · ${h.label}`);
			glyphRoles.push("muted");
		} else {
			body.push(`● ${server.name} · ${h.label}`);
			glyphRoles.push("error");
			if (h.preview) {
				body.push(`  ${h.preview}`);
				glyphRoles.push(undefined);
			}
		}
	}
	if (servers.length > shown.length) {
		body.push(`+${servers.length - shown.length} more`);
		glyphRoles.push(undefined);
	}
	const extra = [...errors.map((error) => `⚠ ${error}`), ...(live?.check === "unavailable" ? ["⚠ Status unavailable"] : []), ...(projectIgnored ? ["Project mcp.json untrusted"] : [])];
	for (const row of extra) {
		body.push(row);
		glyphRoles.push(undefined);
	}

	let subtitle: string;
	if (servers.length === 0) subtitle = "None";
	else if (!live || live.check === "unavailable") subtitle = `${usable.length}/${servers.length} on`;
	else if (live.check === "checking") subtitle = "checking";
	else subtitle = `${usable.filter((server) => health.get(server)?.kind === "ok").length}/${usable.length} online`;

	const card: HudCard = {
		key: "hud-mcp",
		title: "MCP",
		subtitle,
		tone: errors.length > 0 || redCount > 0 ? "warning" : "info",
		body,
	};
	if (glyphRoles.some((role) => role !== undefined)) card.glyphRoles = glyphRoles;
	return card;
}
