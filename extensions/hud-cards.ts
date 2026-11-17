import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { NativeRenderCard } from "../lib/card.ts";
import { createContextProvider } from "../lib/cards/context-live.ts";
import { createEngramProvider } from "../lib/cards/engram-live.ts";
import { createMcpProvider } from "../lib/cards/mcp-live.ts";
import { createToolsProvider } from "../lib/cards/tools-live.ts";
import { createCardsComponent, loadNativeRenderCard, loadNativeSidebarHover, loadNativeSidebarPart, type CardProvider } from "../lib/host.ts";
import { locateGentlePi } from "../lib/locate.ts";
import { railPatchStatus, type PatchReport } from "../lib/patch.ts";
import { HUD_KEY_PREFIX, mountRail, railNotice, sidebarLoadNotice, type SidebarHoverFn, type SidebarPartFn } from "../lib/rail.ts";

export const WIDGET_KEY = "gentle-hud-cards";

// Rail order: CONTEXT+, ENGRAM, MCP, TOOLS.
export const defaultProviders: CardProvider[] = [createContextProvider(), createEngramProvider(), createMcpProvider(), createToolsProvider()];

export interface HudCardsDeps {
	providers: CardProvider[];
	locateRoot(): string | undefined;
	patchStatus(root: string | undefined): PatchReport;
	loadRenderCard(root: string | undefined): Promise<NativeRenderCard | undefined>;
	loadSidebarPart(root: string | undefined): Promise<SidebarPartFn | undefined>;
	/** Optional: gentle-pi's setSidebarHover, so hover clears when the pointer leaves a card header. */
	loadSidebarHover?(root: string | undefined): Promise<SidebarHoverFn | undefined>;
}

export function createHudCards(deps: HudCardsDeps): (pi: ExtensionAPI) => void {
	return (pi) => {
		// Only hud-* keys can be drawn by the patched rail and never shadow a native section.
		const cards = deps.providers.filter((provider) => provider.key.startsWith(HUD_KEY_PREFIX));
		let native: NativeRenderCard | undefined;
		let sidebarPart: SidebarPartFn | undefined;
		let sidebarHover: SidebarHoverFn | undefined;
		let requestRender: (() => void) | undefined;
		let notified = false;
		const root = deps.locateRoot();
		// Read once at load, when gentle-shell loaded the same layout file: patching
		// mid-session takes effect only after /reload, which reloads this too.
		const patch = deps.patchStatus(root);
		const loaded = Promise.all([deps.loadRenderCard(root), deps.loadSidebarPart(root), deps.loadSidebarHover?.(root)]).then(([renderCard, part, hover]) => {
			native = renderCard;
			sidebarPart = part;
			sidebarHover = hover;
		});

		// Providers see every event first (registered before the host handlers, so
		// state is fresh when the render request fires); one throwing never blocks the rest.
		const feed = (type: string) => (event: unknown, ctx: unknown) => {
			for (const provider of cards) {
				try {
					provider.update?.({ ...(event as object), type }, ctx as never);
				} catch {
					// A broken provider update must not break the other cards.
				}
			}
		};
		// tool_execution_end fires for every finished call, blocked ones included.
		for (const type of ["session_start", "turn_end", "message_end", "session_compact", "tool_execution_end"]) pi.on(type as "turn_end", feed(type));
		// Async providers (Engram's HTTP fetch) land between Pi events; redraw when they do.
		for (const provider of cards) {
			try {
				provider.watch?.(() => requestRender?.());
			} catch {
				// A provider that cannot be watched still renders on Pi events.
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			await loaded;
			if (!ctx.hasUI || cards.length === 0) return;
			const rail = patch.status === "patched" && sidebarPart ? sidebarPart : undefined;
			const notice = rail ? undefined : patch.status === "patched" ? sidebarLoadNotice(patch.version) : railNotice(patch);
			if (notice && !notified) {
				notified = true;
				ctx.ui.notify(notice, "warning");
			}
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					requestRender = () => tui.requestRender();
					const bottom = createCardsComponent(cards, theme, () => native);
					// Rail: hud-* parts that the patched layout draws; the bottom widget
					// stays mounted for narrow screens. Unpatched: a plain widget, never
					// sidebarPart, which would blank it whenever the rail owns the host.
					return rail ? mountRail(tui, cards, theme, bottom, rail, sidebarHover) : bottom;
				},
				{ placement: "belowEditor" },
			);
		});

		const refresh = () => requestRender?.();
		pi.on("turn_end", refresh);
		pi.on("message_end", refresh);
		pi.on("session_compact", refresh);
		pi.on("session_shutdown", () => {
			requestRender = undefined;
		});
	};
}

export default createHudCards({
	providers: defaultProviders,
	locateRoot: () => locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync }),
	patchStatus: railPatchStatus,
	loadRenderCard: loadNativeRenderCard,
	loadSidebarPart: loadNativeSidebarPart,
	loadSidebarHover: loadNativeSidebarHover,
});
