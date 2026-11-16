import { join } from "node:path";
import { renderHudCard, type CardTheme, type HudCard, type NativeRenderCard } from "./card.ts";
import type { SidebarPartFn } from "./rail.ts";

export interface CardProvider {
	key: string;
	/** Current card, or undefined when it has nothing to show. */
	card(): HudCard | undefined;
}

type Importer = (path: string) => Promise<Record<string, unknown>>;

/**
 * Import gentle-pi's renderCard by absolute path. Pi's jiti loader transforms
 * the dynamic import (verified against gentle-pi 4.8.0); any failure means
 * "no native renderer" and the cards use the fallback.
 */
export async function loadNativeRenderCard(root: string | undefined, importer: Importer = (path) => import(path)): Promise<NativeRenderCard | undefined> {
	if (!root) return undefined;
	try {
		const mod = await importer(join(root, "lib", "shell-card.ts"));
		return typeof mod.renderCard === "function" ? (mod.renderCard as NativeRenderCard) : undefined;
	} catch {
		return undefined;
	}
}

/** gentle-pi's `sidebarPart` (lib/shell-sidebar.ts), or undefined when it cannot load. */
export async function loadNativeSidebarPart(root: string | undefined, importer: Importer = (path) => import(path)): Promise<SidebarPartFn | undefined> {
	if (!root) return undefined;
	try {
		const mod = await importer(join(root, "lib", "shell-sidebar.ts"));
		return typeof mod.sidebarPart === "function" ? (mod.sidebarPart as SidebarPartFn) : undefined;
	} catch {
		return undefined;
	}
}

/** The fallback host: every provider's card stacked in one component. */
export function createCardsComponent(providers: CardProvider[], theme: CardTheme, native: () => NativeRenderCard | undefined) {
	return {
		render(width: number): string[] {
			const lines: string[] = [];
			for (const provider of providers) {
				let card: HudCard | undefined;
				try {
					card = provider.card();
				} catch {
					continue;
				}
				if (card) lines.push(...renderHudCard(card, theme, width, native()));
			}
			return lines;
		},
		invalidate(): void {},
	};
}
