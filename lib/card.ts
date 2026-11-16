// HUD cards render through gentle-pi's own renderCard when it loads, so they
// follow the native card style and any future style change. The fallback below
// draws the neon frame with the same theme roles, for a gentle-pi that moved or
// broke its card module (S4): degraded, never blank.

export type CardTone = "info" | "success" | "warning" | "error";

export interface HudCard {
	/** Sidebar key; always `hud-` prefixed so the rail patch can find it. */
	key: string;
	title: string;
	subtitle?: string;
	body: string[];
	tone: CardTone;
}

export interface CardTheme {
	fg(role: string, text: string): string;
	bg?(role: string, text: string): string;
}

/** gentle-pi `lib/shell-card.ts` renderCard, as far as this package relies on it. */
export type NativeRenderCard = (
	card: { title: string; subtitle?: string; body: string[]; tone: CardTone },
	theme: CardTheme,
	width: number,
	options: { expanded: boolean; panel?: boolean },
) => string[];

const GLYPH = "✿";
const MIN_WIDTH = 8;

// Same mapping as gentle-pi: INFO keeps the plain border with an accent title;
// every other tone paints frame and title in its own role.
const frameRole = (tone: CardTone) => (tone === "info" ? "border" : tone);
export const titleRole = (tone: CardTone) => (tone === "info" ? "accent" : tone);

/** Cut plain text to `width` columns, ending in … when it had to cut. */
export function truncate(text: string, width: number): string {
	const chars = [...text];
	return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function fit(text: string, width: number): string {
	const cut = truncate(text, width);
	return cut + " ".repeat(Math.max(0, width - [...cut].length));
}

export function fallbackRenderCard(card: HudCard, theme: CardTheme, width: number): string[] {
	if (width < MIN_WIDTH) return [];
	const frame = (text: string) => theme.fg(frameRole(card.tone), text);
	const inner = width - 4;
	const label = `${GLYPH} ${card.title}`;
	const title = [...label].length > width - 6 ? fit(label, width - 6) : label;
	const rule = "─".repeat(width - 5 - [...title].length);
	const top = frame("╭─ ") + theme.fg(titleRole(card.tone), title) + frame(` ${rule}╮`);
	const body = card.body.map((line) => `${frame("│ ")}${fit(line, inner)}${frame(" │")}`);
	return [top, ...body, frame(`╰${"─".repeat(width - 2)}╯`)];
}

const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every((line) => typeof line === "string");

/** Render with the native renderer when it works, else with the fallback. */
export function renderHudCard(card: HudCard, theme: CardTheme, width: number, native: NativeRenderCard | undefined): string[] {
	if (native) {
		try {
			const lines = native({ title: card.title, subtitle: card.subtitle, body: card.body, tone: card.tone }, theme, width, { expanded: true, panel: true });
			if (isLines(lines)) return lines;
		} catch {
			// A changed native signature must degrade to the fallback, not blank the card.
		}
	}
	return fallbackRenderCard(card, theme, width);
}
