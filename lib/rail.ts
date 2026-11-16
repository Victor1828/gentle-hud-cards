import { titleRole, truncate, type CardTheme, type HudCard } from "./card.ts";
import type { CardProvider } from "./host.ts";
import type { PatchStatus } from "./patch.ts";

// Rail host: each card is its own `hud-*` sidebar part. The rail paints the
// card chrome itself from the part's rows: row 0 is the header (`▾ TITLE  count`),
// the rest is the body, indented like native panel rows.

const ROW_INDENT = "  "; // gentle-pi PANEL_ROW_INDENT

interface Component {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

export type SidebarPartFn = (tui: unknown, key: string, bottom: Component, rail: Component & { digest?(): string }) => Component;

export function createRailPart(provider: CardProvider, theme: CardTheme) {
	const current = (): HudCard | undefined => {
		try {
			return provider.card();
		} catch {
			return undefined;
		}
	};
	return {
		render(width: number): string[] {
			const card = current();
			if (!card) return [];
			const role = titleRole(card.tone);
			const count = card.subtitle ? `  ${theme.fg("dim", card.subtitle)}` : "";
			const header = `${theme.fg(role, "▾")} ${theme.fg(role, truncate(card.title, Math.max(1, width - 2)))}${count}`;
			return [header, ...card.body.map((row) => ROW_INDENT + truncate(row, Math.max(1, width - ROW_INDENT.length)))];
		},
		/** The rail re-renders a part only when this changes. */
		digest(): string {
			return JSON.stringify(current() ?? null);
		},
		invalidate(): void {},
	};
}

/**
 * Register every provider as a rail part. The first part carries the stacked
 * bottom widget (shown when the rail does not own the screen); the others
 * paint nothing below the editor.
 */
export function mountRail(tui: unknown, providers: CardProvider[], theme: CardTheme, bottom: Component, sidebarPart: SidebarPartFn): Required<Component> {
	const empty: Component = { render: () => [], invalidate() {} };
	const parts = providers.map((provider, index) => sidebarPart(tui, provider.key, index === 0 ? bottom : empty, createRailPart(provider, theme)));
	return {
		render: (width: number) => (parts[0] ?? bottom).render(width),
		invalidate(): void {},
		dispose(): void {
			for (const part of parts) part.dispose?.();
		},
	};
}

/** The one-time notice for a session that cannot use the rail; undefined when patched. */
export function railNotice({ status, version }: { status: PatchStatus; version?: string }): string | undefined {
	const gentlePi = version ? `gentle-pi ${version}` : "gentle-pi";
	switch (status) {
		case "patched":
			return undefined;
		case "unpatched":
			return `gentle-hud-cards: the ${gentlePi} sidebar rail is not patched, so the HUD cards render below the editor. Run \`npm run rail:patch\` in the gentle-hud-cards repo, then /reload.`;
		case "unknown":
			return `gentle-hud-cards: ${gentlePi} changed its sidebar layout, so the rail patch was not applied and the HUD cards render below the editor. Run \`npm run rail:status\` in the gentle-hud-cards repo for details.`;
		case "missing":
			return "gentle-hud-cards: gentle-pi was not found (set GENTLE_HUD_GENTLE_PI_ROOT), so the HUD cards render below the editor.";
	}
}
