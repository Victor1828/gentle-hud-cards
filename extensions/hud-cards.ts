import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { NativeRenderCard } from "../lib/card.ts";
import { createCardsComponent, loadNativeRenderCard, loadNativeSidebarPart, type CardProvider } from "../lib/host.ts";
import { locateGentlePi } from "../lib/locate.ts";
import { railPatchStatus } from "../lib/patch.ts";
import { mountRail, railNotice, type SidebarPartFn } from "../lib/rail.ts";

export const WIDGET_KEY = "gentle-hud-cards";

// Cards register here as they land (T4 Contexto+, T5 Engram, T6 MCP, T7 Tools).
const providers: CardProvider[] = [];

export default function hudCards(pi: ExtensionAPI): void {
	let native: NativeRenderCard | undefined;
	let sidebarPart: SidebarPartFn | undefined;
	let requestRender: (() => void) | undefined;
	let notified = false;
	const root = locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync });
	// Read once at load, when gentle-shell loaded the same layout file: patching
	// mid-session takes effect only after /reload, which reloads this too.
	const patch = railPatchStatus(root);
	const loaded = Promise.all([loadNativeRenderCard(root), loadNativeSidebarPart(root)]).then(([renderCard, part]) => {
		native = renderCard;
		sidebarPart = part;
	});

	pi.on("session_start", async (_event, ctx) => {
		await loaded;
		if (!ctx.hasUI || providers.length === 0) return;
		const rail = patch.status === "patched" && sidebarPart ? sidebarPart : undefined;
		const notice = rail ? undefined : railNotice(patch.status === "patched" ? { status: "unknown", version: patch.version } : patch);
		if (notice && !notified) {
			notified = true;
			ctx.ui.notify(notice, "warning");
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				const bottom = createCardsComponent(providers, theme, () => native);
				// Rail: hud-* parts that the patched layout draws; the bottom widget
				// stays mounted for narrow screens. Unpatched: a plain widget, never
				// sidebarPart, which would blank it whenever the rail owns the host.
				return rail ? mountRail(tui, providers, theme, bottom, rail) : bottom;
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
}
