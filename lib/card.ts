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
	/**
	 * Optional theme role per body row (same index) that paints the row's FIRST
	 * character, e.g. a status `●` in `success` or `error`. Rows stay plain text
	 * until render; cutting to the width happens before the escape is added.
	 */
	glyphRoles?: Array<string | undefined>;
	tone: CardTone;
	/** Rail header keeps its tone color (bold) instead of the native white title; only CONTEXT+ sets it. */
	keepToneColor?: boolean;
}

export interface CardTheme {
	fg(role: string, text: string): string;
	bold?(text: string): string;
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

/** Terminal cells for one code point: 0 for combining marks, 2 for East Asian wide and emoji, else 1. */
function cellWidth(code: number): number {
	if (code < 0x300) return 1;
	if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	const wide =
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd);
	return wide ? 2 : 1;
}

/** Visible width of plain text (no escape sequences) in terminal cells. */
export function textWidth(text: string): number {
	let width = 0;
	for (const char of text) width += cellWidth(char.codePointAt(0) ?? 0);
	return width;
}

/** Cut plain text to `width` cells, ending in … when it had to cut. Plain text only: paint after cutting. */
export function truncate(text: string, width: number): string {
	if (textWidth(text) <= width) return text;
	const room = Math.max(0, width - 1);
	let used = 0;
	let out = "";
	for (const char of text) {
		const next = used + cellWidth(char.codePointAt(0) ?? 0);
		if (next > room) break;
		used = next;
		out += char;
	}
	return `${out}…`;
}

function fit(text: string, width: number): string {
	const cut = truncate(text, width);
	return cut + " ".repeat(Math.max(0, width - textWidth(cut)));
}

/** Paint the first character of `row` with a theme role; a row without a role or text is returned as is. */
export function paintGlyph(row: string, role: string | undefined, theme: CardTheme): string {
	if (!role || row === "") return row;
	const first = [...row][0];
	return theme.fg(role, first) + row.slice(first.length);
}

export function fallbackRenderCard(card: HudCard, theme: CardTheme, width: number): string[] {
	if (width < MIN_WIDTH) return [];
	const frame = (text: string) => theme.fg(frameRole(card.tone), text);
	const inner = width - 4;
	const label = `${GLYPH} ${card.title}`;
	const title = textWidth(label) > width - 6 ? fit(label, width - 6) : label;
	const rule = "─".repeat(width - 5 - textWidth(title));
	const top = frame("╭─ ") + theme.fg(titleRole(card.tone), title) + frame(` ${rule}╮`);
	const body = card.body.map((line, i) => `${frame("│ ")}${paintGlyph(fit(line, inner), card.glyphRoles?.[i], theme)}${frame(" │")}`);
	return [top, ...body, frame(`╰${"─".repeat(width - 2)}╯`)];
}

const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every((line) => typeof line === "string");

/** Render with the native renderer when it works, else with the fallback. */
export function renderHudCard(card: HudCard, theme: CardTheme, width: number, native: NativeRenderCard | undefined): string[] {
	if (native) {
		try {
			const body = card.glyphRoles ? card.body.map((line, i) => paintGlyph(line, card.glyphRoles?.[i], theme)) : card.body;
			const lines = native({ title: card.title, subtitle: card.subtitle, body, tone: card.tone }, theme, width, { expanded: true, panel: true });
			if (isLines(lines)) return lines;
		} catch {
			// A changed native signature must degrade to the fallback, not blank the card.
		}
	}
	return fallbackRenderCard(card, theme, width);
}
