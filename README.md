# gentle-hud-cards

Extra Gentle Shell cards for Pi: **Contexto+**, **Engram**, **MCP**, and **Tools**. The logic is ported and adapted from [hudr2](https://github.com/Totopo27/hudr2) (MIT).

> Status: scaffold only. The renderer and fallback host are ready. The cards land one by one in later tasks, so this version loads but draws nothing yet.

## How it renders

- **Native style.** Cards render through gentle-pi's own `renderCard` (`lib/shell-card.ts`), imported at runtime from the installed gentle-pi. They use the native frame, card style, and live theme roles, so they follow `/gentle:customize` and theme changes.
- **Fallback style.** If gentle-pi cannot be found, or its `renderCard` is missing or throws, a built-in renderer draws the same rounded frame with the same theme roles. INFO uses `border` and `accent`; other tones use their own role.
- **Placement.** Cards render as a widget below the editor. Placing them in the sidebar rail needs a local gentle-pi patch, which is not part of this version.

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
