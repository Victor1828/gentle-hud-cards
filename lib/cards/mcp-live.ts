import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { CardProvider, CardUpdateContext, CardUpdateEvent } from "../host.ts";
import { mcpAgentDir, mcpCard, readMcpConfig, type McpConfigResult } from "./mcp.ts";

export interface McpProviderOptions {
	read?(input: { cwd?: string; projectTrusted: boolean }): McpConfigResult;
}

const defaultRead = ({ cwd, projectTrusted }: { cwd?: string; projectTrusted: boolean }) =>
	readMcpConfig({
		agentDir: mcpAgentDir(process.env, homedir()),
		cwd,
		projectTrusted,
		readFile: (path) => readFileSync(path, "utf8"),
		exists: existsSync,
	});

function trusted(ctx: CardUpdateContext): boolean {
	try {
		return ctx.isProjectTrusted?.() === true;
	} catch {
		// Pi's safe default: an unknown trust decision ignores the project config.
		return false;
	}
}

/**
 * MCP provider: Pi loads mcp.json once per session, so the card reads it on
 * session_start only; an edited config shows after /reload, like Pi itself.
 */
export function createMcpProvider(options: McpProviderOptions = {}): CardProvider {
	const read = options.read ?? defaultRead;
	let result: McpConfigResult | undefined;
	return {
		key: "hud-mcp",
		update(event: CardUpdateEvent, ctx: CardUpdateContext): void {
			if (event.type !== "session_start") return;
			try {
				result = read({ cwd: ctx.cwd, projectTrusted: trusted(ctx) });
			} catch {
				result = { servers: [], errors: ["MCP config unreadable"], projectIgnored: false };
			}
		},
		card() {
			return result ? mcpCard(result) : undefined;
		},
	};
}
