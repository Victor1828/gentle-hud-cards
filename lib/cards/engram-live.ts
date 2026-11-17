import type { CardProvider, CardUpdateContext, CardUpdateEvent } from "../host.ts";
import { engramCard, ENGRAM_URL, fetchEngramSnapshot, type EngramSnapshot, type FetchLike } from "./engram.ts";

/** turn_end refreshes once this long has passed since the last result; session_start always refreshes. */
export const ENGRAM_MIN_REFRESH_MS = 30_000;

export interface EngramProviderOptions {
	fetchSnapshot?(cwd: string | undefined): Promise<EngramSnapshot>;
	now?(): number;
}

const defaultFetchSnapshot = (cwd: string | undefined) =>
	fetchEngramSnapshot({ fetch: globalThis.fetch as unknown as FetchLike, baseUrl: ENGRAM_URL, cwd });

/**
 * Engram provider: `update` is synchronous but HTTP is not, so it starts a
 * background fetch, caches the snapshot, and tells watchers when it lands so
 * the host can request a render. `card()` never touches the network.
 */
export function createEngramProvider(options: EngramProviderOptions = {}): CardProvider {
	const fetchSnapshot = options.fetchSnapshot ?? defaultFetchSnapshot;
	const now = options.now ?? Date.now;
	const listeners: Array<() => void> = [];
	let started = false;
	let cwd: string | undefined;
	let snapshot: EngramSnapshot = { status: "checking" };
	// Each session_start opens a new generation; results from older ones are dropped.
	let generation = 0;
	let inFlight = false;
	let lastResultAt = 0;

	const notify = () => {
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One broken watcher must not starve the others.
			}
		}
	};

	const refresh = () => {
		const mine = generation;
		inFlight = true;
		let next: Promise<EngramSnapshot>;
		try {
			next = fetchSnapshot(cwd);
		} catch {
			next = Promise.resolve({ status: "offline" });
		}
		next
			.catch((): EngramSnapshot => ({ status: "offline" }))
			.then((result) => {
				if (mine !== generation) return;
				inFlight = false;
				// From the result, not the request: a slow daemon must not trigger an immediate refetch.
				lastResultAt = now();
				snapshot = result;
				notify();
			});
	};

	return {
		key: "hud-engram",
		update(event: CardUpdateEvent, ctx: CardUpdateContext): void {
			if (event.type === "session_start") {
				started = true;
				generation++;
				cwd = ctx.cwd;
				snapshot = { status: "checking" };
				refresh();
				return;
			}
			if (started && event.type === "turn_end" && !inFlight && now() - lastResultAt >= ENGRAM_MIN_REFRESH_MS) refresh();
		},
		watch(listener: () => void): void {
			listeners.push(listener);
		},
		card() {
			return started ? engramCard(snapshot, now()) : undefined;
		},
	};
}
