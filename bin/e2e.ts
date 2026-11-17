// End-to-end check against the installed gentle-pi, without a TTY.
//
// It copies gentle-pi's lib/ into a temp dir (one patched copy, one unpatched
// copy), loads the copies with Pi's own jiti loader, and drives the real
// extension (`createHudCards`) into the real rail layout, the real renderCard,
// and Pi's real theme. The installed gentle-pi is only read, never written.
//
// Exit: 0 every check passed, 1 a check failed, 2 gentle-pi or Pi not found.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHudCards, type HudCardsDeps } from "../extensions/hud-cards.ts";
import type { NativeRenderCard } from "../lib/card.ts";
import { createContextProvider } from "../lib/cards/context-live.ts";
import { createEngramProvider } from "../lib/cards/engram-live.ts";
import { createMcpProvider } from "../lib/cards/mcp-live.ts";
import { createToolsProvider } from "../lib/cards/tools-live.ts";
import { loadNativeRenderCard, loadNativeSidebarPart, type CardProvider } from "../lib/host.ts";
import { locateGentlePi } from "../lib/locate.ts";
import { patchLayout, railPatchStatus, unpatchLayout } from "../lib/patch.ts";

const COLUMNS = 140; // gentle-pi's SIDEBAR_BREAKPOINT: the rail owns the host from here.
const ROWS = 60;
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) => lines.map((line) => line.replace(ANSI, ""));

type Handler = (event: unknown, ctx: unknown) => unknown;
type Component = { render(width: number): string[]; invalidate?(): void };
type Theme = { fg(role: string, text: string): string; bg(role: string, text: string): string; bold(text: string): string };

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
}

const root = locateGentlePi({ env: process.env, execPath: process.execPath, exists: existsSync });
const piRoot = root && join(root, "node_modules", "@earendil-works", "pi-coding-agent");
if (!root || !piRoot || !existsSync(join(piRoot, "dist"))) {
	console.error(`gentle-pi or its Pi runtime not found${root ? ` at ${root}` : ""}; set GENTLE_HUD_GENTLE_PI_ROOT`);
	process.exit(2);
}
const version = (createRequire(join(root, "package.json"))(join(root, "package.json")) as { version?: string }).version ?? "unknown";

const hostImport = (path: string) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const { createJiti } = await hostImport("core/extensions/jiti-loader.js");
const { VIRTUAL_MODULES } = await hostImport("core/extensions/virtual-modules.js");
const pi = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const nativeTheme = await hostImport("modes/interactive/theme/theme.js");
const piTui = createRequire(join(piRoot, "package.json"));
const { renderLayoutFrame } = await import(pathToFileURL(piTui.resolve("@earendil-works/pi-tui/dist/layout.js")).href);
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: VIRTUAL_MODULES, tryNative: false });
const jitiImport = (path: string) => loader.import(path) as Promise<Record<string, unknown>>;

// The live theme proxy, like Gentle Shell's: colors are read at render time.
const theme: Theme = {
	fg: (role, text) => nativeTheme.theme.fg(role, text),
	bg: (role, text) => nativeTheme.theme.bg(role, text),
	bold: (text) => nativeTheme.theme.bold(text),
};

function providers(): CardProvider[] {
	const now = Date.now();
	return [
		createContextProvider({ readReserve: () => 16_384 }),
		createEngramProvider({ fetchSnapshot: async () => ({ status: "online", version: "3.7.0", memories: 42, statsError: false, lastHandoff: now - 3_600_000 }), now: () => now }),
		createMcpProvider({ read: () => ({ servers: [{ name: "engram", transport: "stdio", enabled: true, source: "global" }], errors: [], projectIgnored: false }) }),
		createToolsProvider(),
	];
}

const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read" }, { type: "toolCall", id: "t2", name: "mem_search" }] } }];

/** A fullscreen host at the rail breakpoint, shaped like gentle-pi's own layout tests. */
function host() {
	const original = () => ({ type: "vstack", entries: [] });
	const layoutRoot = { render: () => ["transcript"], invalidate() {}, [NODE]: original };
	return { mode: "fullscreen", terminal: { columns: COLUMNS, rows: ROWS }, layoutRoot, requestRender() {} };
}

/** Load the extension against one gentle-pi copy and start a session in a fake host. */
async function session(copyRoot: string) {
	const cards = providers();
	const nativeCalls = { count: 0 };
	const deps: HudCardsDeps = {
		providers: cards,
		locateRoot: () => copyRoot,
		patchStatus: railPatchStatus,
		loadRenderCard: async (r) => {
			const render = await loadNativeRenderCard(r, jitiImport);
			if (!render) return undefined;
			const counted: NativeRenderCard = (...args) => (nativeCalls.count++, render(...args));
			return counted;
		},
		loadSidebarPart: (r) => loadNativeSidebarPart(r, jitiImport),
	};
	const handlers = new Map<string, Handler[]>();
	createHudCards(deps)({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) } as never);
	const tui = host();
	const notices: string[] = [];
	let widget: Component | undefined;
	const ctx = {
		hasUI: true,
		cwd: "/e2e",
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
		isProjectTrusted: () => false,
		ui: {
			notify: (message: string) => notices.push(message),
			setWidget: (_key: string, factory: (tui: unknown, theme: unknown) => Component) => (widget = factory(tui, theme)),
		},
	};
	const fire = async (type: string, event: object = {}) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};
	await fire("session_start", { reason: "startup" });
	await fire("tool_execution_end", { toolCallId: "t3", toolName: "bash", isError: false });
	await new Promise((resolve) => setTimeout(resolve, 0)); // Engram's async snapshot lands.
	return { tui, cards, notices, widget: () => widget, nativeCalls, titles: cards.map((card) => card.card()?.title ?? "?") };
}

async function railFrame(copyRoot: string, tui: ReturnType<typeof host>): Promise<() => string[]> {
	const layout = await jitiImport(join(copyRoot, "lib", "shell-sidebar-layout.ts"));
	const sidebar = await jitiImport(join(copyRoot, "lib", "shell-sidebar.ts"));
	// A footer part stands in for the native Status section, which the rail draws last.
	(sidebar.sidebarPart as (...args: unknown[]) => unknown)(tui, "footer", { render: () => ["STATUS-FOOTER"], invalidate() {} });
	(layout.installSidebar as (tui: unknown, theme: unknown) => () => void)(tui, theme);
	return () => renderLayoutFrame(tui.layoutRoot, COLUMNS, ROWS, () => {}).lines as string[];
}

const indexOf = (lines: string[], text: string) => lines.findIndex((line) => line.includes(text));
const temp = mkdtempSync(join(tmpdir(), "gentle-hud-e2e-"));
try {
	console.log(`gentle-pi ${version} at ${root}`);
	pi.initTheme("dark");
	const copy = (from: string, name: string) => {
		const dir = join(temp, name);
		cpSync(join(from, "lib"), join(dir, "lib"), { recursive: true });
		return dir;
	};
	// The original layout: the install as-is, or restored from the backup the patch left next to it.
	const unpatchedRoot = copy(root, "unpatched");
	if (railPatchStatus(unpatchedRoot).status === "patched") unpatchLayout(unpatchedRoot);
	check("patch: the original layout is recovered", railPatchStatus(unpatchedRoot).status === "unpatched", railPatchStatus(unpatchedRoot).status);
	const patchedRoot = copy(unpatchedRoot, "patched");
	const patched = patchLayout(patchedRoot);
	check("patch: the original layout patches cleanly", patched.status === "patched" && patched.changed, JSON.stringify(patched));
	check("patch: the installed gentle-pi is patched (npm run rail:patch)", railPatchStatus(root).status === "patched", railPatchStatus(root).status);

	// S2: the patched rail draws the four cards, in order, before Status.
	const rail = await session(patchedRoot);
	const frame = await railFrame(patchedRoot, rail.tui);
	const dark = frame();
	const lines = plain(dark);
	const positions = rail.titles.map((title) => indexOf(lines, `▾ ${title}`));
	check(`rail: draws ${rail.titles.join(", ")}`, positions.every((at) => at >= 0), `titles ${JSON.stringify(rail.titles)} at ${JSON.stringify(positions)}`);
	check("rail: cards keep their order and sit above the Status footer", positions.every((at, i) => i === 0 || at > positions[i - 1]) && positions[positions.length - 1] < indexOf(lines, "STATUS-FOOTER"), JSON.stringify({ positions, footer: indexOf(lines, "STATUS-FOOTER") }));
	check("rail: live data reaches the rail (TOOLS counts the live bash call)", lines.some((line) => line.includes("Bash: 1")) && lines.some((line) => line.includes("Memory: 1")));
	check("rail: no update notice when the rail is patched", rail.notices.length === 0, rail.notices.join(" | "));
	check("rail: the below-editor copy is blank while the rail owns the host", (rail.widget()?.render(80) ?? ["missing"]).length === 0);

	// S3: a theme switch recolors the cards on the next frame, same text.
	pi.initTheme("light");
	const light = frame();
	const hudRows = (all: string[]) => all.filter((_line, i) => i >= positions[0] && i < indexOf(plain(all), "STATUS-FOOTER"));
	check("theme: switching dark to light changes the cards' colors", hudRows(dark).join("\n") !== hudRows(light).join("\n"));
	check("theme: the switch keeps the same text", plain(hudRows(dark)).join("\n") === plain(hudRows(light)).join("\n"));
	pi.initTheme("dark");

	// S4: an unpatched layout never draws hud-* parts; the cards fall back below the editor.
	const fallback = await session(unpatchedRoot);
	const unpatchedLines = plain((await railFrame(unpatchedRoot, fallback.tui))());
	check("fallback: the unpatched rail draws no HUD card", fallback.titles.every((title) => indexOf(unpatchedLines, `▾ ${title}`) < 0));
	check("fallback: one notice says the rail is not patched", fallback.notices.length === 1 && /not patched/.test(fallback.notices[0]), fallback.notices.join(" | "));
	const below = plain(fallback.widget()?.render(60) ?? []);
	check("fallback: the four cards stack below the editor", fallback.titles.every((title) => indexOf(below, title) >= 0), below.slice(0, 6).join(" / "));
	check("fallback: they render through gentle-pi's renderCard", fallback.nativeCalls.count >= fallback.cards.length, `native calls: ${fallback.nativeCalls.count}`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
console.log(failures === 0 ? "e2e: all checks passed" : `e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
