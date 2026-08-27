import { expect, test } from "@playwright/test";

/**
 * The composer box holds one row — the input column and the send cluster — and
 * the box's own padding is the only inset around it, so the space above that
 * row equals the space below it.
 *
 * The textarea's floor is declared as `min-height: 1lh`, which resolves against
 * the role rather than restating its px. jsdom applies no `min-height` and lays
 * out no text, so the unit tests can only pin that the declaration is in
 * line-box units and that the resize handler writes no floor of its own.
 * Whether `1lh` actually derives the role's line box is visible only here. A
 * retune of Body that breaks it fails in this spec and nowhere else.
 *
 * The row is taller than the line box, because the send control sets its
 * height. That is why the insets are measured from the row and the line box is
 * checked on the textarea itself — the two are no longer the same measurement.
 */

const BOX = "[data-chat-composer-box]";
// The row the box ends on. Named rather than taken positionally: the box also
// holds an error alert, a disabled hint, and the pending-upload list, so "the
// last child" would quietly become one of those and measure the wrong gap.
const ROW = "[data-chat-composer-input-row]";
// The chrome sits *outside* the box, under it. Asserted below, because moving it
// back inside would silently restore the geometry this spec exists to pin.
const TOOLBAR = "[data-chat-composer-toolbar]";

test("the composer box holds one row, inset only by its own padding", async ({ page }) => {
  await page.goto("/chat");
  // A cold rsbuild dev server compiles the route's chunk on demand.
  await expect(page.locator(`${BOX} textarea`)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);

  const geometry = await page.evaluate(
    ({ boxSelector, rowSelector, toolbarSelector }) => {
      const box = document.querySelector(boxSelector);
      const textarea = box?.querySelector("textarea");
      const row = box?.querySelector(rowSelector);
      const toolbar = document.querySelector(toolbarSelector);
      if (!box || !textarea || !row || !toolbar) return null;

      const boxStyle = getComputedStyle(box);
      const textareaStyle = getComputedStyle(textarea);
      const boxRect = box.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();

      const laidOut = [...box.querySelectorAll("*")].filter(
        (node) => node.getBoundingClientRect().height > 0,
      );
      const describe = (node: Element) =>
        typeof node.className === "string" && node.className ? node.className : node.tagName;

      return {
        lineBox: Number.parseFloat(textareaStyle.lineHeight),
        // `1lh` reaches computed style already resolved to px.
        declaredFloor: Number.parseFloat(textareaStyle.minHeight),
        textareaHeight: textarea.getBoundingClientRect().height,
        topInset: rowRect.top - boxRect.top,
        bottomInset: boxRect.bottom - rowRect.bottom,
        declaredInset:
          Number.parseFloat(boxStyle.paddingTop) + Number.parseFloat(boxStyle.borderTopWidth),
        toolbarIsOutsideBox: !box.contains(toolbar),
        // Only the send cluster shares the box with the input.
        controlsInBox: [...box.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
        above: laidOut
          .filter((node) => !node.contains(row) && node.getBoundingClientRect().top < rowRect.top)
          .map(describe),
        below: laidOut
          .filter(
            (node) => !node.contains(row) && node.getBoundingClientRect().bottom > rowRect.bottom,
          )
          .map(describe),
      };
    },
    { boxSelector: BOX, rowSelector: ROW, toolbarSelector: TOOLBAR },
  );

  expect(geometry, `no composer rendered at ${BOX}`).not.toBeNull();
  if (!geometry) return;

  // The chrome is a caption strip under the box, not a row inside it.
  expect(geometry.toolbarIsOutsideBox, "the toolbar moved back inside the box").toBe(true);
  expect(
    geometry.controlsInBox,
    "something other than the send cluster is in the box",
  ).not.toContain("Upload files");

  // The resting composer: nothing between the box's edges and its one row.
  expect(geometry.above, "something renders above the input row").toEqual([]);
  expect(geometry.below, "something renders below the input row").toEqual([]);

  // Rects come back fractional, and the device scale a runner reports moves the
  // last digit, so the comparisons hold to the nearest pixel. The drift this
  // spec exists to catch is a whole padding step wide.
  //
  // The floor derives the role's line box rather than a number that once
  // matched it.
  expect(geometry.declaredFloor).toBeCloseTo(geometry.lineBox, 0);
  expect(geometry.textareaHeight).toBeCloseTo(geometry.lineBox, 0);

  // Nothing but the box's own padding sits around the row, so the two ends of
  // the box measure the same.
  expect(geometry.topInset).toBeCloseTo(geometry.declaredInset, 0);
  expect(geometry.topInset).toBeCloseTo(geometry.bottomInset, 0);
});
