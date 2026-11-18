// Agent advice for CONTEXT+ (S14): a quiet `context_advice` tool the model calls
// when its recommendation changes. The schema and guidelines are sent on every
// request, so both stay as short as the behavior allows.

export const ADVICE_TOOL = "context_advice";
export const ADVICE_ACTIONS = ["keep", "compact", "new_session"] as const;
export type AdviceAction = (typeof ADVICE_ACTIONS)[number];
export const REASON_MAX = 40;

export interface Advice {
	action: Exclude<AdviceAction, "keep">;
	reason: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Plain one-line text: ANSI and control characters stripped, whitespace collapsed. Any input type is accepted. */
export function sanitizeReason(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(ANSI, " ").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

const isAction = (value: unknown): value is AdviceAction => (ADVICE_ACTIONS as readonly unknown[]).includes(value);

/**
 * Advice from a result's `details`. `null` = malformed (ignore); `undefined` = `keep` (withdraws advice);
 * otherwise the advice to show.
 */
export function parseAdvice(details: unknown): Advice | undefined | null {
	if (typeof details !== "object" || details === null) return null;
	const { action, reason } = details as { action?: unknown; reason?: unknown };
	if (!isAction(action)) return null;
	if (action === "keep") return undefined;
	return { action, reason: sanitizeReason(reason) };
}

/** Advice carried by a successful `context_advice` tool result (a `tool_execution_end` event or a session toolResult message). */
function adviceOfResult(toolName: unknown, isError: unknown, details: unknown): Advice | undefined | null {
	return toolName === ADVICE_TOOL && isError !== true ? parseAdvice(details) : null;
}

export function adviceFromEvent(event: unknown): Advice | undefined | null {
	const e = event as { toolName?: unknown; isError?: unknown; result?: { details?: unknown } } | null;
	return adviceOfResult(e?.toolName, e?.isError, e?.result?.details);
}

/**
 * The latest successful `context_advice` result AFTER the latest compaction entry
 * (a compaction judged the old context, so earlier advice is stale). Malformed entries are skipped.
 */
export function adviceFromBranch(branch: unknown): Advice | undefined {
	if (!Array.isArray(branch)) return undefined;
	let from = 0;
	branch.forEach((entry, i) => {
		if ((entry as { type?: unknown } | null)?.type === "compaction") from = i + 1;
	});
	for (let i = branch.length - 1; i >= from; i--) {
		const entry = branch[i] as { type?: unknown; message?: { role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown } } | null;
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message || message.role !== "toolResult") continue;
		const advice = adviceOfResult(message.toolName, message.isError, message.details);
		if (advice !== null) return advice;
	}
	return undefined;
}

const EMPTY_COMPONENT = { render: (): string[] => [], invalidate(): void {} };

/** The registerTool definition. Plain JSON Schema: Pi validates any JSON Schema, and this keeps the module free of runtime imports. */
export function createContextAdviceTool() {
	return {
		name: ADVICE_TOOL,
		label: "Context advice",
		description: "Record your advice on the context for the HUD card: keep, compact, or new_session.",
		promptSnippet: "context_advice: show the user a context recommendation (keep, compact, new_session)",
		promptGuidelines: [
			"Call context_advice only when your advice changes, never every turn: new_session if the user moved to an unrelated topic or task, a task finished and the next is unrelated, the context is mostly stale tool output, or repeated compactions lost detail; compact for a long, still-relevant thread at a natural break; keep to withdraw earlier advice. Do not mention it in replies unless asked.",
		],
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...ADVICE_ACTIONS] },
				reason: { type: "string", maxLength: REASON_MAX },
			},
			required: ["action", "reason"],
		},
		// Quiet: the shell draws nothing when the call and result components render no rows.
		renderShell: "self" as const,
		renderCall: () => EMPTY_COMPONENT,
		renderResult: () => EMPTY_COMPONENT,
		async execute(_toolCallId: string, params: { action?: unknown; reason?: unknown }) {
			const action: AdviceAction = isAction(params?.action) ? params.action : "keep";
			const reason = sanitizeReason(params?.reason).slice(0, REASON_MAX);
			return { content: [{ type: "text" as const, text: `Advice recorded: ${action}.` }], details: { action, reason } };
		},
	};
}
