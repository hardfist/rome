import { expect, test } from "@playwright/test";
import { collectInlineTintViolations } from "./layout-invariants.js";

/**
 * Markdown prose keeps its inline tints inside the line they sit on.
 *
 * `/dev/gallery` renders the Markdown specimens at both token bindings —
 * standard and compact — with inline code mid-sentence, alone in a list item,
 * and on a wrapped line. Those are the shapes an overflowing tint shows up in,
 * and the kit's own unit tests can see none of them: jsdom lays out no text,
 * so every rect there is 0x0 and a chip painting over its neighbours measures
 * the same as one that fits.
 *
 * The route sweep in `layout-invariants.spec.ts` leaves `/dev/gallery` out
 * until its intermittent control-geometry violation is diagnosed. This spec
 * measures inline tints only, so that diagnosis does not gate it.
 */

test("inline tints on the gallery fit their line box", async ({ page }) => {
  await page.goto("/dev/gallery");
  // A cold rsbuild dev server compiles the route's chunk on demand.
  await expect(page.locator('[data-streamdown="inline-code"]').first()).toBeVisible({
    timeout: 30_000,
  });
  // Prose geometry is font metrics: measuring before the webfont swaps in
  // reads the fallback's box.
  await page.evaluate(() => document.fonts.ready);

  const violations = await page.evaluate(collectInlineTintViolations);
  const report = violations.map((v) => `  [${v.invariant}] ${v.element}\n    ${v.detail}`).join("\n");

  expect(violations, `inline tint violations on /dev/gallery:\n${report}`).toEqual([]);
});
