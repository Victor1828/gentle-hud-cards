# gentle-hud-cards

Extra Gentle Shell cards for Pi: **Contexto+**, **Engram**, **MCP**, and **Tools**. The logic is ported and adapted from [hudr2](https://github.com/Totopo27/hudr2) (MIT).

> Status: complete. The four cards (**Contexto+**, **Engram**, **MCP**, **Tools**) render in the Gentle Shell rail on gentle-pi 4.8.0, with a below-editor fallback. `npm run e2e` checks the rail, the fallback, and a theme switch against the installed gentle-pi.

## How it renders

- **Native style.** Cards render through gentle-pi's own `renderCard` (`lib/shell-card.ts`), imported at runtime from the installed gentle-pi. They use the native frame, card style, and live theme roles, so they follow `/gentle:customize` and theme changes.
- **Fallback style.** If gentle-pi cannot be found, or its `renderCard` is missing or throws, a built-in renderer draws the same rounded frame with the same theme roles. INFO uses `border` and `accent`; other tones use their own role.
- **Placement.** With the rail patch applied, every card is its own `hud-*` section in the Gentle Shell sidebar rail. In narrow or non-fullscreen layouts the cards stack below the editor. Without the patch they always render below the editor, and the session shows a one-time notice explaining why.

  The notice names the cause: the rail is not patched; gentle-pi changed its layout (the patch anchor no longer matches); gentle-pi was not found; this gentle-pi version has no `lib/shell-sidebar-layout.ts`; the layout could not be read (with the error code); or the patch is applied but gentle-pi's sidebar module could not be loaded. Every case falls back to below the editor.
- **Rail header.** In the rail, each card's header matches the native sections: a muted `▾` glyph, a bold white (`text` role) uppercase title, and a muted subtitle. CONTEXT+ keeps its level color (accent, warning or error) for glyph and title, and is bold too. Hovering the header paints it with the `warning` role, like the native headers.
- **Collapse.** Click a card's header in the rail to collapse it to a single `▸` row; click again to expand. Like the native Todo, Jobs and Status sections, this is not persisted: after `/reload` every card is open. The below-editor fallback does not collapse.
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

## MCP

The `MCP` card lists the MCP servers Pi loads for the session, e.g. `MCP  7/8 on`, then one row per server: `● engram · stdio`, `○ grafana · off` (disabled), `✕ legacy · invalid` (Pi will not start it). After 8 rows it shows `+N more`.

- **Sources**: the same files and merge rule as Pi's built-in MCP extension. First `<agentDir>/mcp.json`, where `agentDir` is `PI_CODING_AGENT_DIR` (Gentle Shell sets `~/.gentle-shell/agent`) or else `~/.pi/agent`. Then `<cwd>/.pi/mcp.json`, only when the project is trusted (`ctx.isProjectTrusted()`).
- **Merge**: a project server with the same name replaces the global one. A project entry without `command`, `url` or `type` only overrides `enabled`.
- **Transport**: `url` is `http`, `command` is `stdio`, and `type: "sse"` or neither field is `invalid`. `enabled` defaults to true.
- **Warnings**: a file that cannot be read or parsed adds a `⚠ global|project mcp.json unreadable|invalid` row and turns the card to warning. An untrusted project that has a `.pi/mcp.json` adds `Project mcp.json untrusted`.
- **Secrets**: only names, transport and `enabled` are kept. `env`, `headers`, `args` and URLs never leave the reader.
- **Limits**: this is configuration, not live state. Pi keeps connection state (connected, failed, needs-auth) private to its MCP extension, and no extension API exposes it. Servers registered by other extensions (`pi.registerMcpServer`) are not listed. The files are read on `session_start`, so edits show after `/reload`, matching Pi.

## Tools

The `TOOLS` card counts this session's tool calls by category, e.g. `TOOLS  20 calls`, then `Reads: 12`, `Writes: 3`, `Bash: 1`, `Memory: 0`, `Other: 4`. With no calls yet it shows `No tool calls yet`.

| Category | Tool names |
| --- | --- |
| Reads | `read`, `grep`, `find`, `ls` |
| Writes | `edit`, `write` |
| Bash | `bash`, `bash_background`, `powershell` |
| Memory | `mem_*`, `mcp__engram__*` |
| Other | everything else (`codemode`, `subagent_*`, other MCP tools, ...) |

- **Live count**: every finished call (`tool_execution_end`, blocked calls included) adds one, once per call id.
- **Model-issued only**: calls made inside another tool (codemode's inner calls, with `parentToolCallId`) are not counted; `codemode` itself counts once as Other. This keeps the live count equal to a rebuild from the session.
- **Rebuild**: on `session_start` (startup, reload, resume, fork) the counts are rebuilt from the assistant `toolCall` blocks in the session branch, and `turn_end` merges the branch again to catch any missed event.

## Show or hide cards

Run `/hud` to pick which cards show. It opens a selector with the four cards in rail order:

```
● CONTEXT+  shown
● ENGRAM  shown
○ MCP  hidden
● TOOLS  shown
```

Choose a row to toggle it. The choice is saved and applied right away, and the selector reopens with the new state. Press Esc to close it. A hidden card disappears from both the rail and the below-editor fallback; showing it brings it back on the next render. Hidden cards keep tracking their data, and collapsing a card (click its header) is independent of hiding it.

- **File**: `<agent dir>/gentle-hud-cards.json`, where the agent dir is `PI_CODING_AGENT_DIR`, else `~/.pi/agent` (Gentle Shell uses `~/.gentle-shell/agent`). It is separate from `/gentle:customize`'s `visual-customization.json`, which rejects unknown keys.
- **Schema**: `{"version": 1, "hidden": ["hud-mcp"]}`. Card keys are `hud-context`, `hud-engram`, `hud-mcp`, `hud-tools`; unknown keys are ignored. A missing file means every card is shown.
- **Invalid file**: not valid JSON, another version, or no `hidden` list of strings. Every card is shown and a warning says so once per session. The file is left untouched until you change a card with `/hud`, which replaces it.
- **Save failure**: reported as an error; nothing changes and the selector reopens.
- **No UI**: `/hud` does nothing.
- Writes are atomic (temp file plus rename) and create the directory if needed.

## Install

Add the package's absolute path to `packages` in the agent settings (`~/.gentle-shell/agent/settings.json`):

```json
{ "packages": ["/Users/victor.vega/gentle-hud-cards"] }
```

If gentle-pi is not installed next to the running `node` binary (`<prefix>/lib/node_modules/gentle-pi`), set `GENTLE_HUD_GENTLE_PI_ROOT` to its package root. An override that has no `lib/shell-card.ts` is ignored, and the next location is tried.

Then apply the rail patch and reload:

```sh
npm run rail:patch
```

Run `/reload` in Gentle Shell. The cards appear in the rail between Agents and Status once the terminal is wide enough for the rail (140 columns), and below the editor otherwise.

## After a gentle-pi update

1. `npm run rail:status`. An update replaces the installed files, so expect `unpatched`.
2. `npm run rail:patch`. A refusal (exit 2) means the new version changed the layout. Nothing is written, and the cards stay below the editor until this package supports it.
3. `npm run e2e` to check the rail, the fallback, and the theme against the new version.
4. `/reload` in Gentle Shell.

## Verify

```sh
npm run e2e
```

It runs the real extension against the installed gentle-pi, without a TTY.

- **How**: it copies gentle-pi's `lib/` into a temp dir, once as the original layout (restored from the patch backup when the install is patched) and once patched. It loads the copies with Pi's own jiti loader and renders frames with Pi's real theme and pi-tui layout, using a fullscreen host at the rail breakpoint, as gentle-pi's own layout tests do.
- **Read only**: the installed gentle-pi is never written. The temp dir is removed at the end.
- **Exit codes**: 0 all checks passed, 1 a check failed, 2 gentle-pi or its Pi runtime was not found.

| Check | Proves |
| --- | --- |
| `patch: ...` | The original layout is recovered and still patches cleanly, and the install itself is patched. |
| `rail: ...` | The patched rail draws CONTEXT+, ENGRAM, MCP, and TOOLS in order above Status, with live data and no notice. The below-editor copy is blank while the rail owns the host. |
| `theme: ...` | Switching Pi's theme from dark to light recolors the cards on the next frame and keeps the same text. |
| `hud: ...` | `/hud` (the real handler, scripted selector, temp agent dir) hides MCP from the real rail frame and from the below-editor stack, writes the expected file, and showing it again restores both. |
| `fallback: ...` | An unpatched rail draws no HUD card, one notice explains why, and the four cards stack below the editor through gentle-pi's `renderCard`. |

The e2e uses fixed card data, so it never depends on the Engram daemon or your MCP config. It does not drive a live Gentle Shell window; check that by eye after `/reload`.

## Uninstall

```sh
npm run rail:unpatch
```

Then remove the package path from `packages` in `~/.gentle-shell/agent/settings.json` and `/reload`. The unpatch restores the exact original bytes.

## Known limits

- **Future patch versions**: a layout that carries a newer `gentle-hud-cards:rail-patch` marker than this package knows is reported as `unknown` and refused. Restore it by hand from `lib/shell-sidebar-layout.ts.gentle-hud-backup`, or reinstall gentle-pi.
- **MCP is configuration only**: Pi keeps live connection state private (see [MCP](#mcp)).
- **Tool names**: `bash_background` and the `mem_*` names are taken from the Gentle Shell tool list. A tool named differently is counted as Other.

## Develop

```sh
npm test       # unit tests: node --experimental-strip-types --test tests/*.test.ts
npm run e2e    # end-to-end against the installed gentle-pi (see Verify)
```

Node `^22.19.0 || >=23.6.0`. There are no runtime dependencies. The Pi packages are peer dependencies that the host provides.
