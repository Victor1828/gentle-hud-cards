import type { CardProvider, CardUpdateContext, CardUpdateEvent } from "../host.ts";
import { assessContext, contextCard } from "./context.ts";
import { adviceFromBranch, adviceFromEvent, type Advice } from "./context-advice.ts";
import { DEFAULT_RESERVE_TOKENS, readReserveTokens } from "./reserve.ts";

/** turn_end samples kept for the growth estimate. */
export const GROWTH_SAMPLES = 5;

export interface ContextProviderOptions {
	readReserve?(ctx: CardUpdateContext): number;
}

const defaultReadReserve = (ctx: CardUpdateContext): number => {
	const model = ctx.model && ctx.model.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	return readReserveTokens({ cwd: ctx.cwd, model });
};

/** Mean of the positive deltas between consecutive samples; drops are compactions and are ignored. */
export function meanGrowth(samples: number[]): number | undefined {
	const deltas: number[] = [];
	for (let i = 1; i < samples.length; i++) if (samples[i] > samples[i - 1]) deltas.push(samples[i] - samples[i - 1]);
	return deltas.length ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length : undefined;
}

function branchCompactions(ctx: CardUpdateContext): number | undefined {
	try {
		const branch = ctx.sessionManager?.getBranch();
		return Array.isArray(branch) ? branch.filter((entry) => (entry as { type?: unknown })?.type === "compaction").length : undefined;
	} catch {
		return undefined;
	}
}

/** Contexto+ provider: a cache refreshed from Pi events, so `card()` never calls Pi. */
export function createContextProvider(options: ContextProviderOptions = {}): CardProvider {
	const readReserve = options.readReserve ?? defaultReadReserve;
	let started = false;
	let reserveTokens = DEFAULT_RESERVE_TOKENS;
	let compactions = 0;
	let samples: number[] = [];
	let usage: { tokens: number | null; contextWindow: number } | undefined;
	// S14: the agent's latest advice; one path sets it live (tool_execution_end), session_start rebuilds it.
	let advice: Advice | undefined;
	let onChange: (() => void) | undefined;

	return {
		key: "hud-context",
		watch(listener: () => void): void {
			onChange = listener;
		},
		update(event: CardUpdateEvent, ctx: CardUpdateContext): void {
			if (event.type === "tool_execution_end" && started) {
				const next = adviceFromEvent(event);
				// null = not a successful, well-formed context_advice result: ignore it.
				if (next !== null && (next?.action !== advice?.action || next?.reason !== advice?.reason)) {
					advice = next;
					try {
						onChange?.();
					} catch {
						// A broken render request must not break the update.
					}
				}
			}
			if (event.type === "session_compact") advice = undefined; // it judged the old context
			if (event.type === "session_start") {
				started = true;
				samples = [];
				compactions = 0;
				try {
					advice = adviceFromBranch(ctx.sessionManager?.getBranch());
				} catch {
					advice = undefined;
				}
				try {
					reserveTokens = readReserve(ctx);
				} catch {
					reserveTokens = DEFAULT_RESERVE_TOKENS;
				}
			}
			// session_shutdown carries a stale context; nothing to recompute.
			if (event.type === "session_shutdown" || !started) return;
			const fromBranch = branchCompactions(ctx) ?? 0;
			compactions = event.type === "session_compact" ? Math.max(fromBranch, compactions + 1) : Math.max(fromBranch, compactions);
			const current = ctx.getContextUsage?.();
			usage = current ? { tokens: typeof current.tokens === "number" ? current.tokens : null, contextWindow: current.contextWindow } : undefined;
			if (event.type === "turn_end" && usage && usage.tokens !== null) samples = [...samples, usage.tokens].slice(-GROWTH_SAMPLES);
		},
		card() {
			if (!started) return undefined;
			return contextCard(
				assessContext({
					tokens: usage?.tokens,
					contextWindow: usage?.contextWindow ?? 0,
					reserveTokens,
					compactions,
					avgTurnGrowth: meanGrowth(samples),
				}),
				advice,
			);
		},
	};
}
