import assert from "node:assert/strict";
import { test } from "node:test";
import { locateGentlePi } from "../lib/locate.ts";

const NVM_NODE = "/home/u/.nvm/versions/node/v24.11.0/bin/node";
const NVM_ROOT = "/home/u/.nvm/versions/node/v24.11.0/lib/node_modules/gentle-pi";

const existsOnly = (...present: string[]) => (path: string) => present.includes(path);

test("locates gentle-pi next to the running node binary", () => {
	const root = locateGentlePi({ env: {}, execPath: NVM_NODE, exists: existsOnly(`${NVM_ROOT}/lib/shell-card.ts`) });
	assert.equal(root, NVM_ROOT);
});

test("GENTLE_HUD_GENTLE_PI_ROOT wins over the node binary location", () => {
	const root = locateGentlePi({
		env: { GENTLE_HUD_GENTLE_PI_ROOT: "/opt/gentle-pi" },
		execPath: NVM_NODE,
		exists: existsOnly("/opt/gentle-pi/lib/shell-card.ts", `${NVM_ROOT}/lib/shell-card.ts`),
	});
	assert.equal(root, "/opt/gentle-pi");
});

test("an override without shell-card.ts falls through to the node binary location", () => {
	const root = locateGentlePi({ env: { GENTLE_HUD_GENTLE_PI_ROOT: "/missing" }, execPath: NVM_NODE, exists: existsOnly(`${NVM_ROOT}/lib/shell-card.ts`) });
	assert.equal(root, NVM_ROOT);
});

test("returns undefined when gentle-pi is not installed", () => {
	assert.equal(locateGentlePi({ env: {}, execPath: NVM_NODE, exists: () => false }), undefined);
});
