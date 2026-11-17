import { join } from "node:path";
import type { HudCard } from "../card.ts";

// MCP card (T6): the servers Pi's built-in MCP extension loads, from the same
// files and with the same merge rule (pi-coding-agent extensions/mcp/config.js):
// `<agentDir>/mcp.json`, then `<cwd>/.pi/mcp.json` only when the project is
// trusted. A project entry with the same name replaces the global one; a project
// entry with no command/url/type only overrides `enabled`. Live connection state
// is private to Pi's MCP extension, so this card shows configuration only.
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

export function mcpCard(result: McpConfigResult): HudCard {
	const { servers, errors, projectIgnored } = result;
	const on = servers.filter((server) => server.enabled && server.transport !== "invalid").length;
	const body = servers.length === 0 ? ["No servers configured"] : servers.slice(0, MAX_SERVER_ROWS).map(serverRow);
	if (servers.length > MAX_SERVER_ROWS) body.push(`+${servers.length - MAX_SERVER_ROWS} more`);
	for (const error of errors) body.push(`⚠ ${error}`);
	if (projectIgnored) body.push("Project mcp.json untrusted");
	return {
		key: "hud-mcp",
		title: "MCP",
		subtitle: servers.length === 0 ? "None" : `${on}/${servers.length} on`,
		tone: errors.length > 0 ? "warning" : "info",
		body,
	};
}
