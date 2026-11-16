import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardsComponent, loadNativeRenderCard, loadNativeSidebarPart, type CardProvider } from "../lib/host.ts";

const theme = { fg: (_role: string, text: string) => text };

test("loadNativeRenderCard imports lib/shell-card.ts from the gentle-pi root", async () => {
	const seen: string[] = [];
	const fn = () => ["x"];
	const loaded = await loadNativeRenderCard("/gp", async (path) => {
		seen.push(path);
		return { renderCard: fn };
	});
	assert.deepEqual(seen, ["/gp/lib/shell-card.ts"]);
	assert.equal(loaded, fn);
});

test("loadNativeRenderCard returns undefined without a root, on import failure, or without renderCard", async () => {
	assert.equal(await loadNativeRenderCard(undefined, async () => ({ renderCard: () => [] })), undefined);
	assert.equal(await loadNativeRenderCard("/gp", async () => { throw new Error("gone"); }), undefined);
	assert.equal(await loadNativeRenderCard("/gp", async () => ({})), undefined);
});

test("loadNativeSidebarPart imports lib/shell-sidebar.ts and degrades to undefined on any failure", async () => {
	const fn = () => ({ render: () => [], invalidate() {} });
	const seen: string[] = [];
	assert.equal(await loadNativeSidebarPart("/gp", async (path) => (seen.push(path), { sidebarPart: fn })), fn);
	assert.deepEqual(seen, ["/gp/lib/shell-sidebar.ts"]);
	assert.equal(await loadNativeSidebarPart(undefined, async () => ({ sidebarPart: fn })), undefined);
	assert.equal(await loadNativeSidebarPart("/gp", async () => { throw new Error("gone"); }), undefined);
	assert.equal(await loadNativeSidebarPart("/gp", async () => ({})), undefined);
});

test("the cards component stacks every provider's card in order and skips empty ones", () => {
	const providers: CardProvider[] = [
		{ key: "hud-a", card: () => ({ key: "hud-a", title: "A", tone: "info", body: ["a"] }) },
		{ key: "hud-none", card: () => undefined },
		{ key: "hud-b", card: () => ({ key: "hud-b", title: "B", tone: "info", body: ["b"] }) },
	];
	const native = (c: { title: string }) => [`[${c.title}]`];
	const component = createCardsComponent(providers, theme, () => native);
	assert.deepEqual(component.render(40), ["[A]", "[B]"]);
});

test("a provider that throws is skipped without hiding the others", () => {
	const providers: CardProvider[] = [
		{ key: "hud-bad", card: () => { throw new Error("broken provider"); } },
		{ key: "hud-b", card: () => ({ key: "hud-b", title: "B", tone: "info", body: [] }) },
	];
	const component = createCardsComponent(providers, theme, () => (c: { title: string }) => [`[${c.title}]`]);
	assert.deepEqual(component.render(40), ["[B]"]);
});

test("the cards component reads the renderer at render time so a late native load is picked up", () => {
	let native: ((c: { title: string }) => string[]) | undefined;
	const providers: CardProvider[] = [{ key: "hud-a", card: () => ({ key: "hud-a", title: "A", tone: "info", body: [] }) }];
	const component = createCardsComponent(providers, theme, () => native);
	assert.equal(component.render(20)[0].startsWith("╭─ ✿ A"), true, "fallback before the native renderer loads");
	native = (c) => [`[${c.title}]`];
	assert.deepEqual(component.render(20), ["[A]"]);
});
