import { paintGlyph, titleRole, truncate, type CardTheme, type HudCard } from "./card.ts";
import type { CardProvider } from "./host.ts";
import type { PatchStatus } from "./patch.ts";

// Rail host: each card is its own `hud-*` sidebar part. The rail paints the
// card chrome itself from the part's rows: row 0 is the header (`▾ TITLE  count`),
// the rest is the body, indented like native panel rows.

const ROW_INDENT = "  "; // gentle-pi PANEL_ROW_INDENT
/** The patched layout only draws parts whose key starts with this. */
export const HUD_KEY_PREFIX = "hud-";
const HEADER_GAP = "  ";

const length = (text: string) => [...text].length;

/** `▾ TITLE  subtitle`, never wider than `width`: the title truncates first, the subtitle only fits in what is left. */
function headerText(title: string, subtitle: string | undefined, width: number): { title: string; subtitle: string } {
	const room = Math.max(1, width - 2); // "▾ "
	const shownTitle = truncate(title, room);
	const left = room - length(shownTitle) - HEADER_GAP.length;
	if (!subtitle || left < 2) return { title: shownTitle, subtitle: "" };
	return { title: shownTitle, subtitle: HEADER_GAP + truncate(subtitle, left) };
}

interface Component {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

/** The slice of gentle-pi's TUI mouse event the header click and hover need (pi-tui TuiMouseEvent). */
export interface RailMouseEvent {
	type: string;
	button: string;
	y: number;
}
export interface RailMouseResult {
	handled: boolean;
	render?: boolean;
}

export type SidebarPartFn = (tui: unknown, key: string, bottom: Component, rail: Component & { digest?(): string; handleMouse?(event: RailMouseEvent): RailMouseResult | undefined }) => Component;
/** gentle-pi `setSidebarHover(tui, owner, clear)`. */
export type SidebarHoverFn = (tui: unknown, owner?: object, clear?: () => void) => void;

export interface RailPartHooks {
	requestRender?(): void;
	setHover?(owner: object, clear: () => void): void;
}

const HOVER_ROLE = "warning"; // gentle-pi shell-hover HOVER_ROLE

export function createRailPart(provider: CardProvider, theme: CardTheme, hooks: RailPartHooks = {}) {
	const current = (): HudCard | undefined => {
		try {
			return provider.card();
		} catch {
			return undefined;
		}
	};
	// Like the native cards, collapse and hover live in memory only: /reload opens every card.
	let collapsed = false;
	let hovered = false;
	const part = {
		render(width: number): string[] {
			const card = current();
			if (!card) return [];
			// gentle-pi renderPanelHeader: muted glyph, bold `text` title, muted subtitle; hover swaps to the warning role.
			const titleColor = hovered ? HOVER_ROLE : card.keepToneColor ? titleRole(card.tone) : "text";
			const glyphColor = hovered ? HOVER_ROLE : card.keepToneColor ? titleRole(card.tone) : "muted";
			const text = headerText(card.title.toUpperCase(), card.subtitle, width);
			const name = theme.bold ? theme.bold(text.title) : text.title;
			const count = text.subtitle ? HEADER_GAP + theme.fg("muted", text.subtitle.slice(HEADER_GAP.length)) : "";
			const header = `${theme.fg(glyphColor, collapsed ? "▸" : "▾")} ${theme.fg(titleColor, name)}${count}`;
			if (collapsed) return [header];
			return [header, ...card.body.map((row, i) => ROW_INDENT + paintGlyph(truncate(row, Math.max(1, width - ROW_INDENT.length)), card.glyphRoles?.[i], theme))];
		},
		/** The rail re-renders a part only when this changes. */
		digest(): string {
			return JSON.stringify([current() ?? null, collapsed, hovered]);
		},
		/** The layout passes part-relative rows: y 0 is the header (gentle-pi lib/shell-sidebar-layout.ts dispatchPartMouse). */
		handleMouse(event: RailMouseEvent): RailMouseResult | undefined {
			const onHeader = event.y === 0;
			if (event.type === "move" && event.button === "none") {
				if (onHeader) hooks.setHover?.(part, clearHover);
				if (onHeader === hovered) return onHeader ? { handled: true } : undefined;
				hovered = onHeader;
				hooks.requestRender?.();
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left" || !onHeader) return undefined;
			collapsed = !collapsed;
			hooks.requestRender?.();
			return { handled: true, render: true };
		},
		invalidate(): void {
			hovered = false;
		},
	};
	const clearHover = () => {
		if (!hovered) return;
		hovered = false;
		hooks.requestRender?.();
	};
	return part;
}

/**
 * Register every provider as a rail part. The first part carries the stacked
 * bottom widget (shown when the rail does not own the screen); the others
 * paint nothing below the editor.
 */
export function mountRail(tui: unknown, providers: CardProvider[], theme: CardTheme, bottom: Component, sidebarPart: SidebarPartFn, setSidebarHover?: SidebarHoverFn): Required<Component> {
	const hooks: RailPartHooks = {
		requestRender: () => (tui as { requestRender?(): void } | undefined)?.requestRender?.(),
		setHover: setSidebarHover ? (owner, clear) => setSidebarHover(tui, owner, clear) : undefined,
	};
	const empty: Component = { render: () => [], invalidate() {} };
	// A key outside the hud- namespace would never be drawn, or would shadow a native section.
	const accepted = providers.filter((provider) => provider.key.startsWith(HUD_KEY_PREFIX));
	const parts = accepted.map((provider, index) => sidebarPart(tui, provider.key, index === 0 ? bottom : empty, createRailPart(provider, theme, hooks)));
	return {
		render: (width: number) => (parts[0] ?? bottom).render(width),
		invalidate(): void {},
		dispose(): void {
			for (const part of parts) part.dispose?.();
		},
	};
}

/** The one-time notice for a session that cannot use the rail; undefined when patched. */
export function railNotice({ status, version, code }: { status: PatchStatus; version?: string; code?: string }): string | undefined {
	const gentlePi = version ? `gentle-pi ${version}` : "gentle-pi";
	switch (status) {
		case "patched":
			return undefined;
		case "unpatched":
			return `gentle-hud-cards: the ${gentlePi} sidebar rail is not patched, so the HUD cards render below the editor. Run \`npm run rail:patch\` in the gentle-hud-cards repo, then /reload.`;
		case "unknown":
			return `gentle-hud-cards: ${gentlePi} changed its sidebar layout, so the rail patch was not applied and the HUD cards render below the editor. Run \`npm run rail:status\` in the gentle-hud-cards repo for details.`;
		case "no-layout":
			return `gentle-hud-cards: ${gentlePi} has no lib/shell-sidebar-layout.ts; this version is not supported, so the HUD cards render below the editor.`;
		case "unreadable":
			return `gentle-hud-cards: ${code ?? "an error"} reading ${gentlePi}'s lib/shell-sidebar-layout.ts, so the rail patch could not be checked and the HUD cards render below the editor.`;
		case "missing":
			return "gentle-hud-cards: gentle-pi was not found (set GENTLE_HUD_GENTLE_PI_ROOT), so the HUD cards render below the editor.";
	}
}

/** The notice for a patched layout whose `sidebarPart` did not load (the patch itself is fine). */
export function sidebarLoadNotice(version?: string): string {
	return `gentle-hud-cards: the rail patch is applied, but ${version ? `gentle-pi ${version}` : "gentle-pi"}'s sidebar module could not be loaded, so the HUD cards render below the editor.`;
}
