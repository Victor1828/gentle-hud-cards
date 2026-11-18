import { truncate, type CardTone, type HudCard } from "../card.ts";
import { sanitizeReason, type Advice } from "./context-advice.ts";

// Contexto+ (S8). Every threshold lives here, named, so the rule is tuned in one place.

/** Mature from this share of the context window... */
export const MATURE_PERCENT = 40;
/** ...or from this many tokens, whichever comes first. */
export const MATURE_TOKENS = 120_000;
/** Saturated from this share of the window... */
export const SATURATED_PERCENT = 70;
/** ...or this many tokens... */
export const SATURATED_TOKENS = 200_000;
/** ...or when this many turns or fewer remain before auto-compact. */
export const SATURATED_TURNS_LEFT = 2;
/** From this many compactions, Mature/Saturated recommend a new session. */
export const COMPACTIONS_FOR_NEW_SESSION = 1;

export type ContextLevel = "fresh" | "mature" | "saturated" | "unknown";
export type Recommendation = "keep-going" | "compact-later" | "compact-now" | "new-session";

export interface ContextInput {
	/** Estimated context tokens; null/undefined when Pi does not know yet. */
	tokens?: number | null;
	contextWindow: number;
	reserveTokens: number;
	compactions: number;
	/** Mean token growth per turn, when known. */
	avgTurnGrowth?: number;
}

export interface ContextAssessment {
	level: ContextLevel;
	/** Whole percent of the window in use (rounded down); undefined when unknown. */
	percent?: number;
	tokens?: number;
	contextWindow: number;
	compactions: number;
	/** Pi auto-compacts above `contextWindow - reserveTokens`. */
	autoCompactAt: number;
	tokensToCompact?: number;
	turnsLeft?: number;
	recommendation?: Recommendation;
}

export function assessContext(input: ContextInput): ContextAssessment {
	const { contextWindow, reserveTokens, compactions, avgTurnGrowth } = input;
	const autoCompactAt = contextWindow - reserveTokens;
	const tokens = typeof input.tokens === "number" && Number.isFinite(input.tokens) && input.tokens >= 0 ? input.tokens : undefined;
	if (tokens === undefined || !(contextWindow > 0)) return { level: "unknown", contextWindow, compactions, autoCompactAt };

	const tokensToCompact = Math.max(0, autoCompactAt - tokens);
	const turnsLeft = avgTurnGrowth !== undefined && avgTurnGrowth > 0 ? Math.floor(tokensToCompact / avgTurnGrowth) : undefined;
	// Integer cross-multiplication keeps 40.0 / 70.0 exact on both sides of the boundary.
	const atLeast = (percent: number) => tokens * 100 >= contextWindow * percent;
	const level: ContextLevel =
		atLeast(SATURATED_PERCENT) || tokens >= SATURATED_TOKENS || (turnsLeft !== undefined && turnsLeft <= SATURATED_TURNS_LEFT)
			? "saturated"
			: atLeast(MATURE_PERCENT) || tokens >= MATURE_TOKENS
				? "mature"
				: "fresh";
	const recommendation: Recommendation =
		level === "fresh" ? "keep-going" : compactions >= COMPACTIONS_FOR_NEW_SESSION ? "new-session" : level === "mature" ? "compact-later" : "compact-now";
	return { level, percent: Math.floor((tokens * 100) / contextWindow), tokens, contextWindow, compactions, autoCompactAt, tokensToCompact, turnsLeft, recommendation };
}

const trimmed = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ""));

/** 999 → `999`, 1_234 → `1.2k`, 124_000 → `124k`, 1_500_000 → `1.5M`. */
export function formatTokens(n: number): string {
	if (n < 1_000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = trimmed(n / 1_000);
		if (Number(k) < 1_000) return `${k}k`;
	}
	return `${trimmed(n / 1_000_000)}M`;
}

const LEVEL_LABEL: Record<ContextLevel, string> = { fresh: "Fresh", mature: "Mature", saturated: "Saturated", unknown: "Unknown" };
const LEVEL_TONE: Record<ContextLevel, CardTone> = { fresh: "info", mature: "warning", saturated: "error", unknown: "info" };

function recommendationLine(a: ContextAssessment): string | undefined {
	switch (a.recommendation) {
		case "keep-going":
			return "→ Keep going";
		case "compact-later":
			return "→ /compact at next break";
		case "compact-now":
			return "→ /compact now";
		case "new-session":
			// The Compactions row already shows the count; rows must fit the ~30-column rail.
			return "→ Start a new session";
		default:
			return undefined;
	}
}

const MAX_SHOWN_TURNS = 99;

const AGENT_LABEL: Record<Advice["action"], string> = { new_session: "new session", compact: "/compact" };
/** The reason row is indented two columns and cut to the card's ~28 columns. */
const REASON_COLUMNS = 26;

export function contextCard(a: ContextAssessment, advice?: Advice): HudCard {
	const body: string[] = [];
	if (a.level === "unknown" || a.tokens === undefined) {
		body.push("Usage unknown");
	} else {
		body.push(`${a.percent}% · ${formatTokens(a.tokens)} / ${formatTokens(a.contextWindow)}`);
		// Past 99 the exact estimate is noise and would overflow the rail.
		const count = a.turnsLeft !== undefined && a.turnsLeft > MAX_SHOWN_TURNS ? `${MAX_SHOWN_TURNS}+` : `${a.turnsLeft}`;
		const turns = a.turnsLeft === undefined ? "" : ` · ~${count} ${a.turnsLeft === 1 ? "turn" : "turns"}`;
		body.push(a.tokensToCompact === 0 ? "Auto-compact due now" : `Compact in ${formatTokens(a.tokensToCompact ?? 0)}${turns}`);
	}
	body.push(`Compactions: ${a.compactions}`);
	const line = recommendationLine(a);
	if (line) body.push(line);
	const card: HudCard = { key: "hud-context", title: "CONTEXT+", subtitle: LEVEL_LABEL[a.level], body, tone: LEVEL_TONE[a.level], keepToneColor: true };
	if (!advice) return card;
	// S14: the agent's own advice sits below the threshold rows, which stay as they are.
	const glyphRoles: Array<string | undefined> = body.map(() => undefined);
	body.push(`✦ Agent: ${AGENT_LABEL[advice.action]}`);
	glyphRoles.push("accent");
	const reason = sanitizeReason(advice.reason);
	if (reason) {
		body.push(`  ${truncate(reason, REASON_COLUMNS)}`);
		glyphRoles.push(undefined);
	}
	return { ...card, glyphRoles };
}
