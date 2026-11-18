// End-to-end check against the installed gentle-pi, without a TTY.
//
// It copies gentle-pi's lib/ into a temp dir (one patched copy, one unpatched
// copy), loads the copies with Pi's own jiti loader, and drives the real
// extension (`createHudCards`) into the real rail layout, the real renderCard,
// and Pi's real theme. The installed gentle-pi is only read, never written.
//
// Exit: 0 every check passed, 1 a check failed, 2 gentle-pi or Pi not found.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHudCards, type HudCardsDeps } from "../extensions/hud-cards.ts";
import type { NativeRenderCard } from "../lib/card.ts";
import { createContextProvider } from "../lib/cards/context-live.ts";
import { createEngramProvider } from "../lib/cards/engram-live.ts";
import { createMcpProvider } from "../lib/cards/mcp-live.ts";
import { parseMcpList } from "../lib/cards/mcp-status.ts";
import { createToolsProvider } from "../lib/cards/tools-live.ts";
import { loadNativeRenderCard, loadNativeSidebarHover, loadNativeSidebarPart, type CardProvider } from "../lib/host.ts";
import { locateGentlePi } from "../lib/locate.ts";
import { patchLayout, railPatchStatus, unpatchLayout } from "../lib/patch.ts";
import { createVisibilityStore, VISIBILITY_FILE } from "../lib/visibility.ts";

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
// Headless chalk emits no SGR at all; force it so bold is observable (the same chalk instance Pi's theme uses).
const chalk = (await import(pathToFileURL(piTui.resolve("chalk")).href)).default as { level: number };
chalk.level = 3;
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: VIRTUAL_MODULES, tryNative: false });
const jitiImport = (path: string) => loader.import(path) as Promise<Record<string, unknown>>;

// The live theme proxy, like Gentle Shell's: colors are read at render time.
const theme: Theme = {
	fg: (role, text) => nativeTheme.theme.fg(role, text),
	bg: (role, text) => nativeTheme.theme.bg(role, text),
	bold: (text) => nativeTheme.theme.bold(text),
};

const MCP_SECRET = "hunter2pass-E2E";
const FAKE_MCP_LIST = JSON.stringify({
	servers: [
		{ name: "engram", state: "connected", transport: "engram mcp", enabled: true, tools: ["mem_save"] },
		{ name: "pganalyze", state: "failed", transport: "https://mcp.example/pg", enabled: true, tools: [], error: `401 Unauthorized\nAuthorization: Bearer ${MCP_SECRET}` },
	],
	errors: [],
});

function providers(): CardProvider[] {
	const now = Date.now();
	return [
		createContextProvider({ readReserve: () => 16_384 }),
		createEngramProvider({ fetchSnapshot: async () => ({ status: "online", version: "3.7.0", memories: 42, statsError: false, lastHandoff: now - 3_600_000 }), now: () => now }),
		// A fake status runner: the real parser sees `pi mcp list --json`-shaped text, so no Pi or server starts.
		createMcpProvider({
			read: () => ({ servers: [{ name: "engram", transport: "stdio", enabled: true, source: "global" }, { name: "pganalyze", transport: "http", enabled: true, source: "global" }], errors: [], projectIgnored: false }),
			runStatus: async () => parseMcpList(FAKE_MCP_LIST) ?? [],
		}),
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
async function session(copyRoot: string, agentDir: string) {
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
		loadSidebarHover: (r) => loadNativeSidebarHover(r, jitiImport),
		// A temp agent dir: the e2e never reads or writes the real ~/.gentle-shell/agent.
		visibility: createVisibilityStore(join(agentDir, VISIBILITY_FILE)),
	};
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	createHudCards(deps)({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), registerCommand: (name: string, options: never) => commands.set(name, options) } as never);
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
			select: async (_title: string, options: string[]) => options[script.shift() ?? -1],
		},
	};
	const script: number[] = [];
	/** Run the real /hud handler with a scripted selector: row indexes, then escape. */
	const hud = (...rows: number[]) => (script.push(...rows), commands.get("hud")!.handler("", ctx));
	const fire = async (type: string, event: object = {}) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};
	await fire("session_start", { reason: "startup" });
	await fire("tool_execution_end", { toolCallId: "t3", toolName: "bash", isError: false });
	await new Promise((resolve) => setTimeout(resolve, 0)); // Engram's async snapshot lands.
	return { tui, cards, notices, hud, widget: () => widget, nativeCalls, titles: cards.map((card) => card.card()?.title ?? "?") };
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
	const railAgent = join(temp, "agent-rail");
	const rail = await session(patchedRoot, railAgent);
	const sgr = (role: string) => theme.fg(role, "X").split("X")[0];
	const frame = await railFrame(patchedRoot, rail.tui);
	const dark = frame();
	const lines = plain(dark);
	const positions = rail.titles.map((title) => indexOf(lines, `▾ ${title}`));
	check(`rail: draws ${rail.titles.join(", ")}`, positions.every((at) => at >= 0), `titles ${JSON.stringify(rail.titles)} at ${JSON.stringify(positions)}`);
	check("rail: cards keep their order and sit above the Status footer", positions.every((at, i) => i === 0 || at > positions[i - 1]) && positions[positions.length - 1] < indexOf(lines, "STATUS-FOOTER"), JSON.stringify({ positions, footer: indexOf(lines, "STATUS-FOOTER") }));
	check("rail: live data reaches the rail (TOOLS counts the live bash call)", lines.some((line) => line.includes("Bash: 1")) && lines.some((line) => line.includes("Memory: 1")));
	// S13: the MCP card's status circles use theme roles in the real rail frame: success for online, error for failed.
	const mcpRows = dark.filter((line) => /engram · stdio|pganalyze · failed|401 Unauthorized/.test(line.replace(ANSI, "")));
	const engramRow = mcpRows.find((line) => line.includes("engram · stdio")) ?? "";
	const failedRow = mcpRows.find((line) => line.includes("pganalyze · failed")) ?? "";
	const previewRow = mcpRows.find((line) => line.includes("401 Unauthorized")) ?? "";
	check("S13: MCP subtitle counts the online servers: `1/2 online`", lines.some((line) => line.includes("▾ MCP") && line.includes("1/2 online")), lines.filter((line) => line.includes("MCP")).join(" / "));
	check("S13: the connected server's circle is painted with the theme `success` role", engramRow.includes(sgr("success") + "●"), JSON.stringify(engramRow));
	check("S13: the failed server's circle is painted with the theme `error` role", failedRow.includes(sgr("error") + "●"), JSON.stringify(failedRow));
	check("S13: the failed server shows its redacted preview on the next row and no secret anywhere in the frame", plain(dark).some((line) => line.includes("401 Unauthorized")) && !plain(dark).join("\n").includes(MCP_SECRET) && previewRow !== "", JSON.stringify(previewRow));
	check("S13: the failed server sorts above the online one, and the card turns warning", indexOf(plain(dark), "pganalyze · failed") < indexOf(plain(dark), "engram · stdio") && rail.cards[2].card()?.tone === "warning");
	check("rail: no update notice when the rail is patched", rail.notices.length === 0, rail.notices.join(" | "));
	check("rail: the below-editor copy is blank while the rail owns the host", (rail.widget()?.render(80) ?? ["missing"]).length === 0);

	// S11: native title style. TOOLS is bold + the theme's `text` color; CONTEXT+ is bold + its tone color.
	const boldOpen = theme.bold("X").split("X")[0];
	const rowOf = (all: string[], title: string) => all[indexOf(plain(all), `▾ ${title}`)] ?? "";
	const toolsRow = rowOf(dark, "TOOLS");
	check("S11: the theme's bold emits an SGR here (the bold checks are not vacuous)", boldOpen.includes("\x1b["), JSON.stringify(boldOpen));
	check("S11: the TOOLS title is bold and painted with the theme `text` color", toolsRow.includes(boldOpen + "TOOLS") && toolsRow.includes(sgr("text")), JSON.stringify(toolsRow));
	check("S11: the TOOLS glyph is muted, not the tone color", toolsRow.includes(sgr("muted") + "▾"), JSON.stringify(toolsRow));
	const contextRow = rowOf(dark, "CONTEXT+");
	const contextTone = rail.cards[0].card()?.tone === "warning" ? "warning" : rail.cards[0].card()?.tone === "error" ? "error" : "accent";
	check(`S11: the CONTEXT+ title is bold and keeps its tone color (${contextTone})`, contextRow.includes(boldOpen + "CONTEXT+") && contextRow.includes(sgr(contextTone)) && !contextRow.includes(sgr("text") + boldOpen), JSON.stringify(contextRow));

	// S10: a click through the REAL layout's mouse dispatch: the rail ScrollView's handleMouse, which hit-tests
	// the header row and hands the part a part-relative y (gentle-pi tests/shell-sidebar-layout.test.ts does the same).
	type RailScroll = { render(width: number): string[]; handleMouse(event: unknown): { handled: boolean } | undefined };
	const railEntry = (rail.tui.layoutRoot as unknown as Record<symbol, () => { entries: { component: RailScroll; basis: number }[] }>)[NODE]().entries[1];
	const railRows = () => (frame(), plain(railEntry.component.render(railEntry.basis)));
	const clickRow = (title: string, button = "left") => {
		const y = indexOf(railRows(), `${title}`);
		return railEntry.component.handleMouse({ type: "click", button, x: 4, y, screenX: COLUMNS - railEntry.basis + 4, screenY: y, width: railEntry.basis, height: ROWS, shift: false, alt: false, ctrl: false });
	};
	const toolsBody = (rows: string[]) => rows.some((row) => row.includes("Bash: 1"));
	check("click: TOOLS starts open with its body", toolsBody(railRows()) && indexOf(railRows(), "▾ TOOLS") >= 0);
	check("click: a right click on the header does nothing", clickRow("▾ TOOLS", "right") === undefined && toolsBody(railRows()));
	const first = clickRow("▾ TOOLS");
	const collapsed = railRows();
	check("click: the real layout dispatches a left click on the TOOLS header and it is handled", first?.handled === true, JSON.stringify(first));
	check("click: TOOLS collapses to its ▸ header, the other cards stay open", indexOf(collapsed, "▸ TOOLS") >= 0 && !toolsBody(collapsed) && indexOf(collapsed, "▾ CONTEXT+") >= 0 && indexOf(collapsed, "▾ MCP") >= 0, collapsed.join(" / "));
	const second = clickRow("▸ TOOLS");
	const reopened = railRows();
	check("click: a second click expands TOOLS again", second?.handled === true && indexOf(reopened, "▾ TOOLS") >= 0 && toolsBody(reopened), reopened.join(" / "));

	// S3: a theme switch recolors the cards on the next frame, same text.
	pi.initTheme("light");
	const light = frame();
	const hudRows = (all: string[]) => all.filter((_line, i) => i >= positions[0] && i < indexOf(plain(all), "STATUS-FOOTER"));
	check("theme: switching dark to light changes the cards' colors", hudRows(dark).join("\n") !== hudRows(light).join("\n"));
	check("theme: the switch keeps the same text", plain(hudRows(dark)).join("\n") === plain(hudRows(light)).join("\n"));
	pi.initTheme("dark");

	// S12: /hud hides and shows cards in the real rail frame; the file on disk follows.
	const railFile = join(railAgent, VISIBILITY_FILE);
	const mcpIndex = rail.titles.indexOf("MCP");
	check("hud: the file does not exist before the first change", !existsSync(railFile));
	await rail.hud(mcpIndex);
	const hiddenRows = railRows();
	check("hud: hiding MCP removes it from the real rail frame, the others stay", indexOf(hiddenRows, "MCP") < 0 && ["CONTEXT+", "ENGRAM", "TOOLS"].every((title) => indexOf(hiddenRows, `▾ ${title}`) >= 0), hiddenRows.join(" / "));
	check("hud: the file on disk lists hud-mcp", existsSync(railFile) && JSON.stringify(JSON.parse(readFileSync(railFile, "utf8"))) === JSON.stringify({ version: 1, hidden: ["hud-mcp"] }), existsSync(railFile) ? readFileSync(railFile, "utf8") : "missing");
	await rail.hud(mcpIndex);
	const shownRows = railRows();
	check("hud: showing MCP again restores it in its rail position", indexOf(shownRows, "▾ MCP") > indexOf(shownRows, "▾ ENGRAM") && indexOf(shownRows, "▾ MCP") < indexOf(shownRows, "▾ TOOLS"), shownRows.join(" / "));
	check("hud: the file on disk lists nothing hidden again", JSON.stringify(JSON.parse(readFileSync(railFile, "utf8"))) === JSON.stringify({ version: 1, hidden: [] }), readFileSync(railFile, "utf8"));

	// S4: an unpatched layout never draws hud-* parts; the cards fall back below the editor.
	const fallbackAgent = join(temp, "agent-fallback");
	const fallback = await session(unpatchedRoot, fallbackAgent);
	const unpatchedLines = plain((await railFrame(unpatchedRoot, fallback.tui))());
	check("fallback: the unpatched rail draws no HUD card", fallback.titles.every((title) => indexOf(unpatchedLines, `▾ ${title}`) < 0));
	check("fallback: one notice says the rail is not patched", fallback.notices.length === 1 && /not patched/.test(fallback.notices[0]), fallback.notices.join(" | "));
	const below = plain(fallback.widget()?.render(60) ?? []);
	check("fallback: the four cards stack below the editor", fallback.titles.every((title) => indexOf(below, title) >= 0), below.slice(0, 6).join(" / "));
	await fallback.hud(fallback.titles.indexOf("MCP"));
	const belowHidden = plain(fallback.widget()?.render(60) ?? []);
	check("hud: hiding MCP removes it from the below-editor stack, the others stay", indexOf(belowHidden, "MCP") < 0 && ["CONTEXT+", "ENGRAM", "TOOLS"].every((title) => indexOf(belowHidden, title) >= 0), belowHidden.join(" / "));
	await fallback.hud(fallback.titles.indexOf("MCP"));
	check("hud: showing MCP again restores it in the below-editor stack", indexOf(plain(fallback.widget()?.render(60) ?? []), "MCP") >= 0);
	// S13: the native renderCard path keeps the painted glyph, and nothing secret reaches it.
	const belowRaw = fallback.widget()?.render(60) ?? [];
	check("S13: fallback: the failed circle keeps its `error` role through gentle-pi's renderCard", belowRaw.some((line) => line.includes("pganalyze · failed") && line.includes(sgr("error") + "●")), belowRaw.filter((line) => line.includes("pganalyze")).join(" / "));
	check("S13: fallback: the preview is redacted", !plain(belowRaw).join("\n").includes(MCP_SECRET) && plain(belowRaw).some((line) => line.includes("401 Unauthorized")));
	check("fallback: they render through gentle-pi's renderCard", fallback.nativeCalls.count >= fallback.cards.length, `native calls: ${fallback.nativeCalls.count}`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
console.log(failures === 0 ? "e2e: all checks passed" : `e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
