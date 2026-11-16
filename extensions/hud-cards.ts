import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { NativeRenderCard } from "../lib/card.ts";
import { createCardsComponent, loadNativeRenderCard, type CardProvider } from "../lib/host.ts";
import { locateGentlePi } from "../lib/locate.ts";

export const WIDGET_KEY = "gentle-hud-cards";

// Cards register here as they land (T4 Contexto+, T5 Engram, T6 MCP, T7 Tools).
const providers: CardProvider[] = [];

export default function hudCards(pi: ExtensionAPI): void {
	let native: NativeRenderCard | undefined;
	let requestRender: (() => void) | undefined;
	const root = locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync });
	const loaded = loadNativeRenderCard(root).then((fn) => {
		native = fn;
	});

	pi.on("session_start", async (_event, ctx) => {
		await loaded;
		if (!ctx.hasUI || providers.length === 0) return;
		// Fallback host (T2): plain belowEditor widget. Never wrap it in
		// sidebarPart: that wrapper blanks the widget whenever the fullscreen rail
		// owns the host, and the unpatched rail would not draw hud-* parts either.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return createCardsComponent(providers, theme, () => native);
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
