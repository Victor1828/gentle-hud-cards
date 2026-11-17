import type { CardTone, HudCard } from "../card.ts";

// Engram card (T5): daemon health, this project's memory count, and the age of
// the last session_summary (the handoff the next session resumes from). Reads
// only GET endpoints of the local daemon; none of them need auth.

export const ENGRAM_URL = "http://127.0.0.1:7437";
/** Per-request timeout: a hung daemon must not keep a stale "Checking" forever. */
export const ENGRAM_TIMEOUT_MS = 1_500;
/**
 * Recent observations scanned for the newest session_summary. Engram 3.7 ignores
 * a `type` filter on /observations/recent, so the filter runs here.
 */
export const HANDOFF_LOOKBACK = 50;

export type EngramSnapshot =
	| { status: "checking" }
	| { status: "offline" }
	| { status: "unhealthy" }
	| {
			status: "online";
			version?: string;
			memories?: number;
			statsError: boolean;
			/** Epoch ms of the newest session_summary; null when none is in the lookback; undefined when unknown. */
			lastHandoff?: number | null;
	  };

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

const SQLITE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/;

/** Engram stores SQLite `YYYY-MM-DD HH:MM:SS[.fraction]` timestamps in UTC; ISO also accepted. */
export function parseEngramTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const m = SQLITE_TIME.exec(value.trim());
	if (!m) return undefined;
	const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
	const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
	return Number.isFinite(time) ? time : undefined;
}

/** `just now`, `5m ago`, `13h ago` (up to 47h), then `2d ago`. Future times (clock skew) are `just now`. */
export function formatAge(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function newestHandoff(list: unknown): number | null {
	let newest: number | null = null;
	if (!Array.isArray(list)) return null;
	for (const item of list) {
		const obs = item as { type?: unknown; updated_at?: unknown; created_at?: unknown } | null;
		if (obs?.type !== "session_summary") continue;
		const time = parseEngramTime(obs.updated_at) ?? parseEngramTime(obs.created_at);
		if (time !== undefined && (newest === null || time > newest)) newest = time;
	}
	return newest;
}

export interface FetchSnapshotOptions {
	fetch: FetchLike;
	baseUrl: string;
	/** Engram resolves the project from this directory, the same way its own tools do. */
	cwd?: string;
	timeoutMs?: number;
}

export async function fetchEngramSnapshot({ fetch, baseUrl, cwd, timeoutMs = ENGRAM_TIMEOUT_MS }: FetchSnapshotOptions): Promise<EngramSnapshot> {
	// scoped: Engram resolves the project from cwd; /health is global.
	const get = (path: string, params: Record<string, string> = {}, scoped = true) => {
		const url = new URL(path, baseUrl);
		if (scoped && cwd) url.searchParams.set("cwd", cwd);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		return fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
	};

	let version: string | undefined;
	try {
		const res = await get("/health", {}, false);
		const body = (await res.json().catch(() => undefined)) as { status?: unknown; version?: unknown } | undefined;
		if (!res.ok || body?.status !== "ok") return { status: "unhealthy" };
		version = typeof body.version === "string" ? body.version : undefined;
	} catch {
		return { status: "offline" };
	}

	const [stats, handoff] = await Promise.all([
		get("/stats").then(
			async (res) => {
				// 404 unknown_project: Engram has never seen this project, which is zero memories, not an error.
				if (res.status === 404) return { memories: 0, statsError: false };
				if (!res.ok) throw new Error(`stats ${res.status}`);
				const body = (await res.json()) as { total_observations?: unknown };
				return { memories: count(body?.total_observations), statsError: false };
			},
		).catch(() => ({ memories: undefined, statsError: true })),
		get("/observations/recent", { scope: "project", limit: String(HANDOFF_LOOKBACK) }).then(
			async (res) => (res.ok ? newestHandoff(await res.json()) : undefined),
		).catch(() => undefined),
	]);
	return { status: "online", version, ...stats, lastHandoff: handoff };
}

const KEY = "hud-engram";

export function engramCard(snapshot: EngramSnapshot, now: number, where = `:${new URL(ENGRAM_URL).port}`): HudCard {
	const card = (subtitle: string, tone: CardTone, body: string[]): HudCard => ({ key: KEY, title: "ENGRAM", subtitle, tone, body });
	switch (snapshot.status) {
		case "checking":
			return card("Checking", "info", [`Connecting to ${where}`]);
		case "offline":
			return card("Offline", "error", [`Daemon unreachable ${where}`]);
		case "unhealthy":
			return card("Unhealthy", "warning", ["Health check failed"]);
		case "online": {
			const totals = snapshot.statsError || snapshot.memories === undefined ? "Stats unavailable" : `Memories: ${snapshot.memories}`;
			const handoff =
				snapshot.lastHandoff === null ? "No handoff yet" : snapshot.lastHandoff === undefined ? "Last handoff: unknown" : `Last handoff: ${formatAge(now - snapshot.lastHandoff)}`;
			return card(snapshot.version ? `Online · v${snapshot.version}` : "Online", "info", [totals, handoff]);
		}
	}
}
