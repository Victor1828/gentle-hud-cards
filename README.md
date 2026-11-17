# gentle-hud-cards

Extra Gentle Shell cards for Pi: **Contexto+**, **Engram**, **MCP**, and **Tools**. The logic is ported and adapted from [hudr2](https://github.com/Totopo27/hudr2) (MIT).

> Status: renderer, fallback host, rail patch, and the **Contexto+** card are ready. Engram, MCP, and Tools land in later tasks.

## How it renders

- **Native style.** Cards render through gentle-pi's own `renderCard` (`lib/shell-card.ts`), imported at runtime from the installed gentle-pi. They use the native frame, card style, and live theme roles, so they follow `/gentle:customize` and theme changes.
- **Fallback style.** If gentle-pi cannot be found, or its `renderCard` is missing or throws, a built-in renderer draws the same rounded frame with the same theme roles. INFO uses `border` and `accent`; other tones use their own role.
- **Placement.** With the rail patch applied, every card is its own `hud-*` section in the Gentle Shell sidebar rail. In narrow or non-fullscreen layouts the cards stack below the editor. Without the patch they always render below the editor, and the session shows a one-time notice explaining why.

  The notice names the cause: the rail is not patched; gentle-pi changed its layout (the patch anchor no longer matches); gentle-pi was not found; this gentle-pi version has no `lib/shell-sidebar-layout.ts`; the layout could not be read (with the error code); or the patch is applied but gentle-pi's sidebar module could not be loaded. Every case falls back to below the editor.
- **Card keys.** Only providers whose key starts with `hud-` are shown; the patched rail draws nothing else, and the prefix keeps cards from shadowing native sections.

## Rail patch

gentle-pi's rail draws a hard-coded list of sections. The patch changes exactly one line of `lib/shell-sidebar-layout.ts` in the installed gentle-pi so it also draws the `hud-*` parts between Agents and the Status footer:

```sh
npm run rail:status    # patched | unpatched (exit 0); gentle-pi or lib/shell-sidebar-layout.ts missing (exit 1); changed layout (exit 2); layout unreadable or write failed (exit 3)
npm run rail:patch     # apply; idempotent; writes lib/shell-sidebar-layout.ts.gentle-hud-backup
npm run rail:unpatch   # restore the original bytes and remove the matching backup
```

Then run `/reload` in Gentle Shell.

**After every gentle-pi update** the patch is gone, because the update replaces the installed files. Run `npm run rail:patch` again. The patch is applied only when the original line appears exactly once and is followed by the code that reads the sidebar parts. Anything else is refused with exit 2 and nothing is written, and the cards keep working below the editor until this package supports the new layout. The injected code is wrapped in `try`/`catch`, so a future rename inside that function hides the HUD sections instead of breaking the rail.

## Contexto+

The `CONTEXT+` card shows how full the context window is and what to do about it, e.g. `62% · 124k / 200k`, `Compact in 59.6k · ~3 turns`, `Compactions: 0`, and a recommendation line. Pi auto-compacts when usage passes `contextWindow - reserveTokens`; the turns estimate is the room left divided by the average growth of the last 5 turns (hidden until two turns have been seen).

| Level | When | Recommendation |
|---|---|---|
| Fresh (info) | below 40% of the window **and** below 120k tokens | `→ Keep going` |
| Mature (warning) | 40% or more, **or** 120k tokens or more | `→ /compact at next break` |
| Saturated (error) | 70% or more, **or** 200k tokens or more, **or** 2 or fewer turns left before auto-compact | `→ /compact now` |

If the session has already been compacted once or more, Mature and Saturated recommend `→ Start a new session` instead, because summaries of summaries lose detail. Fresh never recommends a new session. The absolute caps matter on huge windows: 40% of 1M tokens is far past the point where long contexts degrade.

When Pi does not know the usage yet (right after a compaction, before the next response) the card says `Usage unknown`.

- **Thresholds** are named constants at the top of `lib/cards/context.ts` (`MATURE_PERCENT`, `SATURATED_PERCENT`, `MATURE_TOKENS`, `SATURATED_TOKENS`, `SATURATED_TURNS_LEFT`, `COMPACTIONS_FOR_NEW_SESSION`).
- **Reserve tokens**: no Pi extension API exposes `compaction.reserveTokens`, so `lib/cards/reserve.ts` reads it at session start from the project `.pi/settings.json`, then the global agent dir (`PI_CODING_AGENT_DIR`, else `~/.gentle-shell/agent`, else `~/.pi/agent`), honoring `compaction.modelOverrides`, and defaults to 16384.
- **Compactions** are counted from `compaction` entries on the session branch plus `session_compact` events, and reset on every `session_start`.

## Engram

The `ENGRAM` card shows whether the local Engram memory daemon is up, how many memories this project has, and how old its last handoff (the newest `session_summary`) is, e.g. `Online · v3.7.0`, `Memories: 42`, `Last handoff: 13h ago`.

| State | Tone | Body |
|---|---|---|
| Checking (right after session start) | info | `Connecting to :7437` |
| Online | info | `Memories: N` (or `Stats unavailable`), then `Last handoff: 13h ago`, `No handoff yet`, or `Last handoff: unknown` |
| Unhealthy (`/health` not ok) | warning | `Health check failed` |
| Offline (connection refused or timed out) | error | `Daemon unreachable :7437` |

- **Endpoints**: only `GET` on `http://127.0.0.1:7437`, none of them auth-gated: `/health`, then in parallel `/stats?cwd=<session cwd>` and `/observations/recent?cwd=<session cwd>&scope=project&limit=50`. Passing `cwd` lets Engram resolve the project the same way its own tools do; an unknown project (404) counts as zero memories.
- **Handoff**: Engram 3.7 ignores a `type` filter on `/observations/recent`, so the card scans the 50 newest project observations for `session_summary`. A handoff older than that window shows as `No handoff yet`. Timestamps are Engram's UTC SQLite format.
- **Refresh**: on every `session_start`, then on `turn_end` once 30 seconds have passed since the last result (`ENGRAM_MIN_REFRESH_MS` in `lib/cards/engram-live.ts`), never two requests at once. Each request times out after 1.5 seconds. Results land between Pi events, so the provider's `watch()` asks the host to redraw.

## Install

Add the package's absolute path to `packages` in the agent settings (`~/.gentle-shell/agent/settings.json`):

```json
{ "packages": ["/Users/victor.vega/gentle-hud-cards"] }
```

If gentle-pi is not installed next to the running `node` binary (`<prefix>/lib/node_modules/gentle-pi`), set `GENTLE_HUD_GENTLE_PI_ROOT` to its package root.

## Develop

```sh
npm test   # node --experimental-strip-types --test tests/*.test.ts
```

Node `^22.19.0 || >=23.6.0`. There are no runtime dependencies. The Pi packages are peer dependencies that the host provides.
