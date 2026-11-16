# gentle-hud-cards

Extra Gentle Shell cards for Pi: **Contexto+**, **Engram**, **MCP**, and **Tools**. The logic is ported and adapted from [hudr2](https://github.com/Totopo27/hudr2) (MIT).

> Status: renderer, fallback host, and rail patch are ready. The cards land one by one in later tasks, so this version loads but draws nothing yet.

## How it renders

- **Native style.** Cards render through gentle-pi's own `renderCard` (`lib/shell-card.ts`), imported at runtime from the installed gentle-pi. They use the native frame, card style, and live theme roles, so they follow `/gentle:customize` and theme changes.
- **Fallback style.** If gentle-pi cannot be found, or its `renderCard` is missing or throws, a built-in renderer draws the same rounded frame with the same theme roles. INFO uses `border` and `accent`; other tones use their own role.
- **Placement.** With the rail patch applied, every card is its own `hud-*` section in the Gentle Shell sidebar rail. In narrow or non-fullscreen layouts the cards stack below the editor. Without the patch they always render below the editor, and the session shows a one-time notice explaining why.

## Rail patch

gentle-pi's rail draws a hard-coded list of sections. The patch changes exactly one line of `lib/shell-sidebar-layout.ts` in the installed gentle-pi so it also draws the `hud-*` parts between Agents and the Status footer:

```sh
npm run rail:status    # patched | unpatched (exit 0), changed layout (exit 2), gentle-pi missing (exit 1)
npm run rail:patch     # apply; idempotent; writes lib/shell-sidebar-layout.ts.gentle-hud-backup
npm run rail:unpatch   # restore the original bytes and remove the matching backup
```

Then run `/reload` in Gentle Shell.

**After every gentle-pi update** the patch is gone, because the update replaces the installed files. Run `npm run rail:patch` again. The patch is applied only when the original line appears exactly once and is followed by the code that reads the sidebar parts. Anything else is refused with exit 2 and nothing is written, and the cards keep working below the editor until this package supports the new layout. The injected code is wrapped in `try`/`catch`, so a future rename inside that function hides the HUD sections instead of breaking the rail.

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
