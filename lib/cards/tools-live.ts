import type { CardProvider, CardUpdateContext, CardUpdateEvent } from "../host.ts";
import { branchToolCalls, categorizeTool, emptyToolCounts, isCountedTool, toolsCard, type ToolCategory } from "./tools.ts";

interface ToolEndEvent extends CardUpdateEvent {
	toolCallId?: unknown;
	toolName?: unknown;
	parentToolCallId?: unknown;
}

function readBranch(ctx: CardUpdateContext): Map<string, ToolCategory> {
	try {
		return branchToolCalls(ctx.sessionManager?.getBranch());
	} catch {
		return new Map();
	}
}

/**
 * A call made inside another tool (codemode's `ctx.executeTool`) carries
 * `parentToolCallId` and an id of the form `<parent>/<n>`. Only model-issued
 * calls count, so the live total agrees with a rebuild from the branch.
 */
function isNested(event: ToolEndEvent): boolean {
	if (event.parentToolCallId !== undefined && event.parentToolCallId !== null && event.parentToolCallId !== "") return true;
	return typeof event.toolCallId === "string" && event.toolCallId.includes("/");
}

/**
 * Tools provider: rebuilds from the branch on session_start (startup, reload,
 * resume, fork), counts each finished call live on tool_execution_end, and
 * merges the branch again on turn_end to catch calls whose event it missed.
 */
export function createToolsProvider(): CardProvider {
	let started = false;
	let calls = new Map<string, ToolCategory>();
	let anonymous = 0;
	let listener: (() => void) | undefined;

	const merge = (ctx: CardUpdateContext) => {
		for (const [id, category] of readBranch(ctx)) calls.set(id, category);
	};

	return {
		key: "hud-tools",
		update(event: CardUpdateEvent, ctx: CardUpdateContext): void {
			if (event.type === "session_start") {
				started = true;
				calls = new Map();
				anonymous = 0;
				merge(ctx);
				return;
			}
			if (!started) return;
			if (event.type === "turn_end") {
				merge(ctx);
				return;
			}
			if (event.type !== "tool_execution_end") return;
			const end = event as ToolEndEvent;
			if (isNested(end)) return;
			const name = typeof end.toolName === "string" ? end.toolName : "";
			if (!isCountedTool(name)) return;
			// No id to dedupe against: still a finished call, so give it a unique key.
			const id = typeof end.toolCallId === "string" && end.toolCallId !== "" ? end.toolCallId : `anonymous:${anonymous++}`;
			if (calls.has(id)) return;
			calls.set(id, categorizeTool(name));
			listener?.();
		},
		watch(fn: () => void): void {
			listener = fn;
		},
		card() {
			if (!started) return undefined;
			const counts = emptyToolCounts();
			for (const category of calls.values()) counts[category]++;
			return toolsCard(counts);
		},
	};
}
