import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { CardProvider, CardUpdateContext, CardUpdateEvent } from "../host.ts";
import { locateGentlePi } from "../locate.ts";
import { mcpAgentDir, mcpCard, readMcpConfig, type McpConfigResult, type McpLiveView } from "./mcp.ts";
import { errorPreview, resolvePiCli, runPiMcpList, type McpServerStatus } from "./mcp-status.ts";

export interface McpStatusInput {
	cwd?: string;
	projectTrusted: boolean;
	/** Aborted when a newer session_start supersedes this run. */
	signal?: AbortSignal;
}

export interface McpProviderOptions {
	read?(input: { cwd?: string; projectTrusted: boolean }): McpConfigResult;
	/** The live status check; the default runs Pi's `mcp list --json`. Tests and the e2e inject a fake so no Pi or server ever starts. */
	runStatus?(input: McpStatusInput): Promise<McpServerStatus[]>;
}

const defaultRead = ({ cwd, projectTrusted }: { cwd?: string; projectTrusted: boolean }) =>
	readMcpConfig({
		agentDir: mcpAgentDir(process.env, homedir()),
		cwd,
		projectTrusted,
		readFile: (path) => readFileSync(path, "utf8"),
		exists: existsSync,
	});

/**
 * The directory the CLI runs in. Pi's `mcp list` decides project trust itself
 * (ProjectTrustStore.get(cwd), mcp/cli.js) and cannot be told otherwise, so an
 * untrusted project runs from the agent dir: `<cwd>/.pi/mcp.json` is then never
 * loaded or connected, matching the card's own trust rule.
 */
export function statusCwd({ cwd, projectTrusted, agentDir }: { cwd?: string; projectTrusted: boolean; agentDir: string }): string {
	return projectTrusted && cwd ? cwd : agentDir;
}

const defaultRunStatus = ({ cwd, projectTrusted, signal }: McpStatusInput): Promise<McpServerStatus[]> => {
	const root = locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync });
	const cliPath = resolvePiCli(root, (path) => readFileSync(path, "utf8"));
	if (!cliPath) return Promise.reject(new Error("pi cli not found"));
	// Inherited env: PI_CODING_AGENT_DIR is what the session uses.
	return runPiMcpList({ cliPath, cwd: statusCwd({ cwd, projectTrusted, agentDir: mcpAgentDir(process.env, homedir()) }), signal });
};

function trusted(ctx: CardUpdateContext): boolean {
	try {
		return ctx.isProjectTrusted?.() === true;
	} catch {
		// Pi's safe default: an unknown trust decision ignores the project config.
		return false;
	}
}

/** Pi's tool-name rule: every character other than letters, digits and `_` becomes `_` (docs/mcp.md). */
const normalizeName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * The configured server a `mcp__<server>__<tool>` call belongs to. Collision
 * hashes only suffix the tool part, so the prefix is stable. Zero or several
 * candidates (e.g. `a` and `a__b`) mean the name cannot be mapped: undefined.
 */
function serverOfTool(toolName: unknown, names: Iterable<string>): string | undefined {
	if (typeof toolName !== "string") return undefined;
	const matches = new Set<string>();
	for (const name of names) {
		const prefix = `mcp__${normalizeName(name)}__`;
		if (toolName.startsWith(prefix) && toolName.length > prefix.length) matches.add(name);
	}
	return matches.size === 1 ? [...matches][0] : undefined;
}

/** The text of a tool result's content blocks, joined; undefined when there is none. The caller derives the preview and drops this. */
function resultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const texts = content.flatMap((block) => (typeof (block as { text?: unknown })?.text === "string" ? [(block as { text: string }).text] : []));
	return texts.length > 0 ? texts.join("\n") : undefined;
}

interface ToolEndEvent extends CardUpdateEvent {
	toolName?: unknown;
	isError?: unknown;
	result?: unknown;
}

/**
 * MCP provider: Pi loads mcp.json once per session, so the config is read on
 * session_start only (edits show after /reload, like Pi). At the same time one
 * background `pi mcp list --json` checks the servers (it reconnects them once);
 * results from an older session_start are dropped. A failing
 * `mcp__<server>__*` tool call turns its server red until a later call succeeds.
 */
export function createMcpProvider(options: McpProviderOptions = {}): CardProvider {
	const read = options.read ?? defaultRead;
	const runStatus = options.runStatus ?? defaultRunStatus;
	const listeners: Array<() => void> = [];
	let result: McpConfigResult | undefined;
	let check: McpLiveView["check"] = "checking";
	let status = new Map<string, McpServerStatus>();
	// Server name to a short redacted preview. The raw error text is never stored.
	let liveErrors = new Map<string, string>();
	// Each session_start opens a new generation; results from older ones are dropped.
	let generation = 0;
	let running: AbortController | undefined;

	const notify = () => {
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One broken watcher must not starve the others.
			}
		}
	};

	const startCheck = (input: { cwd?: string; projectTrusted: boolean }) => {
		const mine = ++generation;
		running?.abort();
		const controller = new AbortController();
		running = controller;
		check = "checking";
		status = new Map();
		liveErrors = new Map();
		let pending: Promise<McpServerStatus[]>;
		try {
			pending = runStatus({ ...input, signal: controller.signal });
		} catch {
			pending = Promise.reject(new Error("status unavailable"));
		}
		pending.then(
			(servers) => {
				if (mine !== generation) return;
				status = new Map(servers.map((server) => [server.name, server]));
				check = "done";
				notify();
			},
			() => {
				if (mine !== generation) return;
				check = "unavailable";
				notify();
			},
		);
	};

	const onToolEnd = (event: ToolEndEvent) => {
		if (!result) return;
		const name = serverOfTool(event.toolName, new Set([...result.servers.map((server) => server.name), ...status.keys()]));
		if (!name) return;
		if (event.isError === true) {
			// Derive the preview and let the raw text go out of scope.
			liveErrors.set(name, errorPreview(resultText(event.result) ?? "") || "tool call failed");
		} else if (!liveErrors.delete(name)) {
			return;
		}
		notify();
	};

	return {
		key: "hud-mcp",
		update(event: CardUpdateEvent, ctx: CardUpdateContext): void {
			if (event.type === "tool_execution_end") return onToolEnd(event as ToolEndEvent);
			if (event.type !== "session_start") return;
			const input = { cwd: ctx.cwd, projectTrusted: trusted(ctx) };
			try {
				result = read(input);
			} catch {
				result = { servers: [], errors: ["MCP config unreadable"], projectIgnored: false };
			}
			// Nothing to check without servers; the card shows the config result alone.
			if (result.servers.length === 0) {
				generation++;
				running?.abort();
				check = "done";
				status = new Map();
				liveErrors = new Map();
				return;
			}
			startCheck(input);
		},
		watch(listener: () => void): void {
			listeners.push(listener);
		},
		card() {
			return result ? mcpCard(result, { check, status, liveErrors }) : undefined;
		},
	};
}
