import type { HudCard } from "../card.ts";

export type ToolCategory = "reads" | "writes" | "bash" | "memory" | "other";
export type ToolCounts = Record<ToolCategory, number>;

export const TOOL_CATEGORIES: readonly ToolCategory[] = ["reads", "writes", "bash", "memory", "other"];
const LABELS: Record<ToolCategory, string> = { reads: "Reads", writes: "Writes", bash: "Bash", memory: "Memory", other: "Other" };

const READS = new Set(["read", "grep", "find", "ls"]);
const WRITES = new Set(["edit", "write"]);
const BASH = new Set(["bash", "bash_background", "powershell"]);

/**
 * Category of a tool as Pi names it. Engram memory tools are `mem_*` when
 * registered natively and `mcp__engram__*` when they come through MCP.
 */
export function categorizeTool(name: string): ToolCategory {
	if (READS.has(name)) return "reads";
	if (WRITES.has(name)) return "writes";
	if (BASH.has(name)) return "bash";
	if (name.startsWith("mem_") || name.startsWith("mcp__engram__")) return "memory";
	return "other";
}

export function emptyToolCounts(): ToolCounts {
	return { reads: 0, writes: 0, bash: 0, memory: 0, other: 0 };
}

/**
 * Model-issued tool calls recorded in the session branch, keyed by call id.
 * Assistant messages carry `{type:"toolCall", id, name}` blocks; codemode's
 * nested calls write no entries, so they never appear here.
 */
export function branchToolCalls(branch: unknown): Map<string, ToolCategory> {
	const calls = new Map<string, ToolCategory>();
	if (!Array.isArray(branch)) return calls;
	for (const entry of branch) {
		const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null)?.message;
		if ((entry as { type?: unknown })?.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type?: unknown; id?: unknown; name?: unknown } | null>) {
			if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
			calls.set(block.id, categorizeTool(block.name));
		}
	}
	return calls;
}

export function toolsCard(counts: ToolCounts): HudCard {
	const total = TOOL_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
	return {
		key: "hud-tools",
		title: "TOOLS",
		subtitle: total === 0 ? "None" : `${total} ${total === 1 ? "call" : "calls"}`,
		tone: "info",
		body: total === 0 ? ["No tool calls yet"] : TOOL_CATEGORIES.map((category) => `${LABELS[category]}: ${counts[category]}`),
	};
}
