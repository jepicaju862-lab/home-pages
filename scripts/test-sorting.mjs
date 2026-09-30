// Uses Playwright installed locally, or HOME_PAGES_PLAYWRIGHT_MODULE pointing to its package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.HOME_PAGES_PLAYWRIGHT_MODULE || "playwright");
const bundle = await esbuild.build({
  entryPoints: ["tests/sorting-fixture.ts"], bundle: true, platform: "browser", format: "iife",
  write: false, alias: { obsidian: resolve("tests/obsidian-stub.ts") }, logLevel: "warning"
});
const css = await readFile("styles.css", "utf8");
const browser = await chromium.launch({ headless: true, channel: process.env.HOME_PAGES_TEST_BROWSER || "chromium" });
// Most checks read card positions right after a drop, so run them without the FLIP slides;
// the "smooth feedback" test turns motion back on.
const page = await browser.newPage({ viewport: { width: 1100, height: 600 }, hasTouch: true, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.setContent("<html><head></head><body></body></html>");
await page.addStyleTag({ content: css + "\nbody { margin: 0; --background-primary: white; --background-secondary: #eee; --interactive-accent: blue; --text-normal: #111; --text-muted: #666; --background-modifier-border: #aaa; }" });
await page.addScriptTag({ content: bundle.outputFiles[0].text });
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const reset = async (options = {}) => { await page.evaluate((o) => window.fixture.reset(o), options); };
const order = () => page.evaluate(() => window.fixture.order().join(""));
const rect = async (selector) => {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `Missing element: ${selector}`);
  return box;
};
const card = (id) => `.hp-card[data-id="${id}"]`;
const point = (box, x = 0.5, y = 0.5) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
const start = async (selector) => { const p = point(await rect(selector)); await page.mouse.move(p.x, p.y); await page.mouse.down(); };
const move = async (p) => { await page.mouse.move(p.x, p.y, { steps: 8 }); };
const drag = async (source, target, x, y) => { await start(source); await move(point(await rect(target), x, y)); await page.mouse.up(); };
const clean = async () => assert.equal(await page.locator(".is-dragging, .is-sorting, .drop-before, .drop-after, .drop-vertical, .hp-sort-ghost").count(), 0);

try {
  await test("mouse sorting updates immediately, saves, and preserves card DOM/config", async () => {
    await reset();
    await page.evaluate(() => { window.originalCard = document.querySelector('.hp-card[data-id="a"]'); });
    await drag(`${card("a")} .hp-card-title`, card("b"), 0.8, 0.5);
    assert.equal(await order(), "bacd");
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll(".hp-card")).map((el) => el.dataset.id).join("")), "bacd");
    assert.equal(await page.evaluate(() => window.originalCard === document.querySelector('.hp-card[data-id="a"]')), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.configs().map((c) => c.preserved)), [1, 0, 2, 3]);
    await page.waitForFunction(() => window.fixture.saved().length > 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.saved()[0]), ["b", "a", "c", "d"]);
    await clean();
  });
  await test("backward move and append to the last position", async () => {
    await reset();
    await drag(`${card("d")} .hp-card-title`, card("a"), 0.2, 0.5);
    assert.equal(await order(), "dabc");
    await drag(`${card("d")} .hp-card-title`, card("c"), 0.8, 0.5);
    assert.equal(await order(), "abcd");
  });
  await test("dropping on the source does not move it to the end", async () => {
    await reset();
    await start(`${card("a")} .hp-card-title`);
    await move(point(await rect(card("b")), 0.8));
    await move(point(await rect(card("a"))));
    await page.mouse.up();
    assert.equal(await order(), "abcd");
    assert.equal(await page.evaluate(() => window.fixture.saved().length), 0);
    await clean();
  });
  await test("gaps resolve to a nearby insertion point", async () => {
    await reset();
    const a = await rect(card("a"));
    const b = await rect(card("b"));
    await start(`${card("d")} .hp-card-title`);
    await move({ x: (a.x + a.width + b.x) / 2, y: b.y + b.height / 2 });
    assert.equal(await page.locator(".drop-before, .drop-after").count(), 1);
    await page.mouse.up();
    assert.equal(await order(), "adbc");
  });
  await test("single-column cards use top/bottom insertion and visible horizontal markers", async () => {
    await page.setViewportSize({ width: 500, height: 600 });
    await reset();
    await start(`${card("a")} .hp-card-title`);
    await move(point(await rect(card("b")), 0.2, 0.8));
    assert.equal(await page.locator(`${card("b")}.drop-after.drop-vertical`).count(), 1);
    const marker = await page.locator(card("b")).evaluate((el) => ({ height: getComputedStyle(el, "::after").height, width: getComputedStyle(el, "::after").width }));
    assert.equal(marker.height, "4px");
    assert.ok(parseFloat(marker.width) > 100);
    await page.mouse.up();
    assert.equal(await order(), "bacd");
    await page.setViewportSize({ width: 1100, height: 600 });
  });
  await test("mixed widths retain the saved visual order instead of dense backfilling", async () => {
    await reset({ widths: [8, 8, 4, 12] });
    const b = await rect(card("b"));
    const c = await rect(card("c"));
    assert.ok(c.y >= b.y);
    assert.equal(await page.locator(".hp-grid").evaluate((el) => getComputedStyle(el).gridAutoFlow), "row");
  });
  await test("Escape cancels and cleans up without saving", async () => {
    await reset();
    await start(`${card("a")} .hp-card-title`);
    await move(point(await rect(card("b")), 0.8));
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await order(), "abcd");
    await clean();
  });
  await test("dropping outside the grid cancels", async () => {
    await reset();
    await start(`${card("a")} .hp-card-title`);
    await move({ x: 1099, y: 599 });
    await page.mouse.up();
    assert.equal(await order(), "abcd");
    await clean();
  });
  await test("normal mode and edit buttons do not start a layout drag", async () => {
    await reset({ editing: false });
    await drag(`${card("a")} .hp-card-title`, card("b"), 0.8, 0.5);
    assert.equal(await order(), "abcd");
    await page.evaluate(() => window.fixture.editing(true));
    await start(`${card("a")} button[aria-label="增加宽度"]`);
    await move(point(await rect(card("b")), 0.8));
    assert.equal(await page.locator(".is-dragging").count(), 0);
    await page.mouse.up();
    assert.equal(await order(), "abcd");
  });
  await test("page tab drag reorders without switching pages; a tap still switches", async () => {
    await reset();
    await drag('.hp-tab[data-id="p1"]', '.hp-tab[data-id="p3"]', 0.8, 0.5);
    assert.deepEqual(await page.evaluate(() => window.fixture.pageOrder()), ["p2", "p3", "p1"]);
    assert.equal(await page.evaluate(() => window.fixture.activePage()), "p1");
    await page.locator('.hp-tab[data-id="p2"]').click();
    assert.equal(await page.evaluate(() => window.fixture.activePage()), "p2");
    await clean();
  });
  await test("touch and pen can drag via the header", async () => {
    await reset();
    const client = await page.context().newCDPSession(page);
    const from = point(await rect(`${card("a")} .hp-card-title`));
    const to = point(await rect(card("b")), 0.8);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await order(), "bacd");
    await reset();
    const penFrom = point(await rect(`${card("a")} .hp-card-title`));
    const penTo = point(await rect(card("b")), 0.8);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...penFrom, button: "left", clickCount: 1, pointerType: "pen" });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...penTo, button: "left", buttons: 1, pointerType: "pen" });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...penTo, button: "left", clickCount: 1, pointerType: "pen" });
    assert.equal(await order(), "bacd");
    await client.detach();
    await clean();
  });
  await test("pointer cancellation, leaving edit mode, switching pages, and closing clean up", async () => {
    for (const action of ["pointercancel", "editing", "switchPage", "close"]) {
      await reset();
      await start(`${card("a")} .hp-card-title`);
      await move(point(await rect(card("b")), 0.8));
      await page.evaluate(async (action) => {
        if (action === "pointercancel") {
          const source = document.querySelector(".is-dragging");
          source.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
        } else if (action === "editing") window.fixture.editing(false);
        else if (action === "switchPage") await window.fixture.switchPage("p2");
        else await window.fixture.close();
      }, action);
      await page.mouse.up();
      assert.equal(await order(), "abcd");
      await clean();
    }
  });
  await test("edge auto-scroll reaches offscreen cards", async () => {
    await reset({ count: 12 });
    await start(`${card("a")} .hp-card-title`);
    await move({ x: 600, y: 535 });
    await page.waitForFunction(() => document.querySelector(".hp-view").scrollTop > 150);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await order(), "abcdefghijkl");
    await clean();
  });
  await test("invalid/self/adjacent insertion is a no-op", async () => {
    const result = await page.evaluate(() => {
      const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const values = [window.fixture.moveBefore(items, "missing", null), window.fixture.moveBefore(items, "a", "missing"),
        window.fixture.moveBefore(items, "a", "a"), window.fixture.moveBefore(items, "a", "b"), window.fixture.moveBefore(items, "c", null)];
      return { values, order: items.map((item) => item.id).join("") };
    });
    assert.deepEqual(result, { values: [false, false, false, false, false], order: "abc" });
  });
  // ---- corner resize ----
  const sizes = () => page.evaluate(() => window.fixture.sizes());
  const units = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelector(".hp-grid"));
    const tracks = style.gridTemplateColumns.split(" ");
    return { col: parseFloat(tracks[0]) + parseFloat(style.columnGap), row: parseFloat(style.gridAutoRows) + parseFloat(style.rowGap), tracks: tracks.length };
  });
  const resizeClean = async () => assert.equal(await page.locator(".is-resizing, .hp-card-size-badge, .hp-resize-frame").count(), 0);
  await test("corner handle resizes by whole columns and rows, saves, and keeps order", async () => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await reset({ widths: [4, 4, 4, 4] });
    const { col, row, tracks } = await units();
    assert.equal(tracks, 12);
    const handle = point(await rect(`${card("a")} .hp-card-resize`));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + col * 2 + 4, handle.y + row + 4, { steps: 8 });
    assert.equal(await page.locator(".hp-card-size-badge").textContent(), "6 列 × 5 行");
    assert.equal(await page.locator(`${card("a")}`).getAttribute("data-w"), "6");
    await page.mouse.up();
    assert.equal(await sizes(), "6x5 4x4 4x4 4x4");
    assert.equal(await order(), "abcd");
    await page.waitForFunction(() => window.fixture.saved().length > 0);
    await resizeClean();
    await clean();
  });
  await test("resize clamps to 1..12 columns and Escape restores the original size", async () => {
    await reset({ widths: [10, 4] });
    const { col } = await units();
    const handle = point(await rect(`${card("a")} .hp-card-resize`));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + col * 5, handle.y, { steps: 6 });
    assert.equal(await page.locator(`${card("a")}`).getAttribute("data-w"), "12");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await sizes(), "10x4 4x4");
    assert.equal(await page.locator(`${card("a")}`).getAttribute("data-w"), "10");
    assert.equal(await page.evaluate(() => window.fixture.saved().length), 0);
    await resizeClean();
  });
  await test("narrow grid resizes height only; arrow keys on the handle step the size", async () => {
    await page.setViewportSize({ width: 500, height: 600 });
    await reset();
    const { col, row } = await units();
    const handle = point(await rect(`${card("a")} .hp-card-resize`));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x - col * 3, handle.y + row * 2 + 4, { steps: 6 });
    await page.mouse.up();
    assert.equal((await sizes()).split(" ")[0], "6x6");
    await page.setViewportSize({ width: 1100, height: 600 });
    await reset();
    await page.locator(`${card("b")} .hp-card-resize`).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => window.fixture.sizes().split(" ")[1] === "7x5");
    await resizeClean();
  });
  await test("resize handle and new-page button: handle hidden outside edit mode, + tab always shown", async () => {
    await reset({ editing: false });
    assert.equal(await page.locator(".hp-card-resize").first().isVisible(), false);
    assert.equal(await page.locator(".hp-tab-add").isVisible(), true);
    await page.evaluate(() => window.fixture.editing(true));
    assert.equal(await page.locator(".hp-card-resize").first().isVisible(), true);
    // a press on the handle must not start a sort
    const handle = point(await rect(`${card("a")} .hp-card-resize`));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 200, handle.y + 5, { steps: 6 });
    assert.equal(await page.locator(".is-sorting, .is-dragging").count(), 0);
    await page.mouse.up();
    assert.equal(await order(), "abcd");
  });
  await test("smooth feedback: preview follows the pointer, cards slide into place, resize frame tracks the pointer", async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1100, height: 600 });
    await reset();
    const a = await rect(card("a"));
    const grab = point(a, 0.3, 0.1);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    const target = point(await rect(card("d")), 0.8, 0.5);
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const ghost = await rect(".hp-sort-ghost");
    assert.ok(Math.abs(ghost.x + a.width * 0.3 - target.x) < 3 && Math.abs(ghost.y + a.height * 0.1 - target.y) < 3, "preview stays under the pointer");
    assert.equal(await page.locator(`${card("a")}.is-dragging`).count(), 1, "original stays as the placeholder");
    await page.mouse.up();
    assert.equal(await order(), "bcda");
    assert.ok(await page.evaluate(() => document.getAnimations().some((animation) => animation.id === "hp-flip")), "cards slide after the drop");
    await clean();
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

    const handle = point(await rect(`${card("b")} .hp-card-resize`));
    const before = await rect(card("b"));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 37, handle.y + 23, { steps: 5 });
    const frame = await rect(".hp-resize-frame");
    assert.ok(Math.abs(frame.width - (before.width + 37)) < 2 && Math.abs(frame.height - (before.height + 23)) < 2, "frame follows the pointer pixel by pixel");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await resizeClean();
    await page.emulateMedia({ reducedMotion: "reduce" });
  });
  assert.deepEqual(errors, []);
  console.log(`ALL ${passed} SORTING CHECKS PASSED`);
} finally {
  await browser.close();
}
