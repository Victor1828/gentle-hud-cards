import assert from "node:assert/strict";
import { test } from "node:test";
import { engramCard, fetchEngramSnapshot, formatAge, HANDOFF_LOOKBACK, parseEngramTime, type EngramSnapshot, type FetchLike } from "../lib/cards/engram.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

type Reply = { status: number; body?: unknown } | Error;

/** A fake fetch keyed by path (query stripped); records every URL and whether it carried an abort signal. */
function fakeFetch(replies: Record<string, Reply>) {
	const calls: Array<{ url: string; signal: boolean }> = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, signal: init?.signal instanceof AbortSignal });
		const reply = replies[new URL(url).pathname];
		if (!reply) throw new Error(`unexpected ${url}`);
		if (reply instanceof Error) throw reply;
		return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
	};
	return { fetch, calls };
}

const health = { status: 200, body: { status: "ok", service: "engram", version: "3.7.0" } };
const stats = { status: 200, body: { total_sessions: 8, total_observations: 2, total_prompts: 6, projects: ["gentle-hud-cards"] } };
const summary = (id: number, updated: string) => ({ id, type: "session_summary", title: "Session summary", created_at: "2026-11-01 00:00:00", updated_at: updated });
const observations = (list: unknown[]) => ({ status: 200, body: list });

test("parseEngramTime: Engram's UTC SQLite timestamps, fractional seconds, ISO, and garbage", () => {
	assert.equal(parseEngramTime("2026-11-17 04:52:05"), Date.UTC(2026, 10, 17, 4, 52, 5));
	assert.equal(parseEngramTime("2026-11-17 18:01:17.912678000"), Date.UTC(2026, 10, 17, 18, 1, 17, 912));
	assert.equal(parseEngramTime("2026-11-17T04:52:05Z"), Date.UTC(2026, 10, 17, 4, 52, 5));
	assert.equal(parseEngramTime("yesterday"), undefined);
	assert.equal(parseEngramTime(undefined), undefined);
	assert.equal(parseEngramTime(42), undefined);
});

test("formatAge: boundaries and clock skew", () => {
	assert.equal(formatAge(-5_000), "just now");
	assert.equal(formatAge(0), "just now");
	assert.equal(formatAge(MIN - 1), "just now");
	assert.equal(formatAge(MIN), "1m ago");
	assert.equal(formatAge(59 * MIN), "59m ago");
	assert.equal(formatAge(HOUR), "1h ago");
	assert.equal(formatAge(47 * HOUR), "47h ago");
	assert.equal(formatAge(48 * HOUR), "2d ago");
});

test("S1: online snapshot from health, cwd-scoped stats, and the newest session_summary", async () => {
	const f = fakeFetch({
		"/health": health,
		"/stats": stats,
		"/observations/recent": observations([
			{ id: 9, type: "architecture", created_at: "2026-11-17 10:00:00", updated_at: "2026-11-17 10:00:00" },
			summary(7, "2026-11-16 04:52:05"),
			summary(8, "2026-11-17 04:52:05.5"),
		]),
	});
	const snap = await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://127.0.0.1:7437", cwd: "/Users/me/my proj" });
	assert.deepEqual(snap, { status: "online", version: "3.7.0", memories: 2, statsError: false, lastHandoff: Date.UTC(2026, 10, 17, 4, 52, 5, 500) });
	const urls = f.calls.map((c) => c.url);
	assert.equal(urls[0], "http://127.0.0.1:7437/health");
	assert.ok(urls.includes("http://127.0.0.1:7437/stats?cwd=%2FUsers%2Fme%2Fmy+proj"), urls.join("\n"));
	assert.ok(urls.includes(`http://127.0.0.1:7437/observations/recent?cwd=%2FUsers%2Fme%2Fmy+proj&scope=project&limit=${HANDOFF_LOOKBACK}`), urls.join("\n"));
	assert.equal(f.calls.length, 3);
	assert.ok(f.calls.every((c) => c.signal), "every request has a timeout signal");
});

test("S1: an unknown project (404) is zero memories; no summary in the lookback is null", async () => {
	const f = fakeFetch({
		"/health": health,
		"/stats": { status: 404, body: { code: "unknown_project", error: "project not found" } },
		"/observations/recent": observations([]),
	});
	assert.deepEqual(await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://h:1", cwd: "/p" }), {
		status: "online",
		version: "3.7.0",
		memories: 0,
		statsError: false,
		lastHandoff: null,
	});
});

test("S1: unreachable daemon is offline and nothing else is requested", async () => {
	const f = fakeFetch({ "/health": new TypeError("fetch failed") });
	assert.deepEqual(await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://h:1", cwd: "/p" }), { status: "offline" });
	assert.equal(f.calls.length, 1);
});

test("S1: a failing health check (500 or status not ok) is unhealthy", async () => {
	for (const reply of [{ status: 500, body: { error: "health check failed" } }, { status: 200, body: { status: "starting" } }]) {
		const f = fakeFetch({ "/health": reply });
		assert.deepEqual(await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://h:1", cwd: "/p" }), { status: "unhealthy" });
		assert.equal(f.calls.length, 1);
	}
});

test("S1: stats failure is statsError; an observations failure leaves the handoff unknown", async () => {
	const f = fakeFetch({ "/health": health, "/stats": { status: 500, body: { error: "stats unavailable" } }, "/observations/recent": new Error("boom") });
	assert.deepEqual(await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://h:1", cwd: "/p" }), {
		status: "online",
		version: "3.7.0",
		memories: undefined,
		statsError: true,
		lastHandoff: undefined,
	});
});

test("S1: without a cwd the daemon picks its default project (no cwd param)", async () => {
	const f = fakeFetch({ "/health": health, "/stats": stats, "/observations/recent": observations([]) });
	await fetchEngramSnapshot({ fetch: f.fetch, baseUrl: "http://h:1" });
	assert.deepEqual(f.calls.map((c) => c.url).sort(), ["http://h:1/health", `http://h:1/observations/recent?scope=project&limit=${HANDOFF_LOOKBACK}`, "http://h:1/stats"]);
});

const now = Date.UTC(2026, 10, 17, 17, 52, 5);
const online = (extra: Partial<Extract<EngramSnapshot, { status: "online" }>> = {}): EngramSnapshot => ({
	status: "online",
	version: "3.7.0",
	memories: 2,
	statsError: false,
	lastHandoff: now - 13 * HOUR,
	...extra,
});

test("S1/S9: online card copy", () => {
	assert.deepEqual(engramCard(online(), now), { key: "hud-engram", title: "ENGRAM", subtitle: "Online · v3.7.0", tone: "info", body: ["Memories: 2", "Last handoff: 13h ago"] });
	assert.equal(engramCard(online({ version: undefined }), now).subtitle, "Online");
	assert.deepEqual(engramCard(online({ lastHandoff: null }), now).body, ["Memories: 2", "No handoff yet"]);
	assert.deepEqual(engramCard(online({ lastHandoff: undefined }), now).body, ["Memories: 2", "Last handoff: unknown"]);
	assert.deepEqual(engramCard(online({ statsError: true, memories: undefined }), now).body, ["Stats unavailable", "Last handoff: 13h ago"]);
});

test("S1/S9: offline, unhealthy, and checking card copy and tones", () => {
	assert.deepEqual(engramCard({ status: "offline" }, now), { key: "hud-engram", title: "ENGRAM", subtitle: "Offline", tone: "error", body: ["Daemon unreachable :7437"] });
	assert.deepEqual(engramCard({ status: "unhealthy" }, now), { key: "hud-engram", title: "ENGRAM", subtitle: "Unhealthy", tone: "warning", body: ["Health check failed"] });
	assert.deepEqual(engramCard({ status: "checking" }, now), { key: "hud-engram", title: "ENGRAM", subtitle: "Checking", tone: "info", body: ["Connecting to :7437"] });
});

test("S3: every row fits the ~28-column rail at realistic sizes", () => {
	const cards = [
		engramCard(online({ memories: 999_999, lastHandoff: now - 99 * 24 * HOUR }), now),
		engramCard({ status: "offline" }, now),
		engramCard({ status: "unhealthy" }, now),
		engramCard({ status: "checking" }, now),
	];
	for (const row of cards.flatMap((c) => c.body)) assert.ok([...row].length <= 28, `${row} is ${[...row].length} columns`);
});
