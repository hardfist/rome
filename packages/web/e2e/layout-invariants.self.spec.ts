import { expect, test } from "@playwright/test";
import {
  collectButtonViolations,
  collectInlineTintViolations,
  collectRowHeightViolations,
} from "./layout-invariants.js";

/**
 * Fixture tests for the `row-height-uniformity` and `sibling-uniformity`
 * collectors themselves.
 *
 * The route sweep in `layout-invariants.spec.ts` passes when the dashboard is
 * clean, which is also what a collector that never fires would do. These pin
 * the two halves the sweep cannot: that a real mismatch is reported, and that
 * each deliberate carve-out stays silent. Fixtures are inline HTML with
 * explicit geometry, so nothing here depends on the design tokens.
 */

const row = (...items: string[]) =>
  `<div style="display:flex;align-items:center;gap:8px">${items.join("")}</div>`;

const button = (h: number, label = "Save") =>
  `<button data-slot="button" style="box-sizing:border-box;height:${h}px">${label}</button>`;

const input = (h: number) =>
  `<input data-slot="input" style="box-sizing:border-box;height:${h}px" value="x" />`;

const CASES: { name: string; html: string; flagged: boolean }[] = [
  {
    name: "control heights disagree on one row",
    html: row(button(36), input(28)),
    flagged: true,
  },
  {
    name: "a select trigger disagreeing with an input",
    html: row(
      input(36),
      `<button data-slot="select-trigger" style="box-sizing:border-box;height:28px">inherit</button>`,
    ),
    flagged: true,
  },
  {
    // IconButton joined the shared size vocabulary in #2280 — it now sizes as
    // size-[var(--control-h-*)], so a square trigger named the same step as the
    // field beside it is the same box, and a mismatch is a real defect.
    name: "an icon button disagreeing with a button",
    html: row(
      button(36),
      `<button data-slot="icon-button" style="height:28px;width:28px"></button>`,
    ),
    flagged: true,
  },
  // The three primitives below carry their own geometry and are legitimately a
  // different height from a control on the same row. Each of these fired as a
  // false positive while the comparison set was "things that look like
  // controls" rather than "things that read --control-h-*".
  {
    name: "a switch beside a button",
    html: row(button(28), `<button data-slot="switch" style="height:16px;width:28px"></button>`),
    flagged: false,
  },
  {
    name: "a badge beside a button",
    html: row(
      button(36),
      `<span data-slot="badge" style="box-sizing:border-box;height:22px;display:inline-flex">New</span>`,
    ),
    flagged: false,
  },
  {
    name: "a tabs trigger beside a button",
    html: row(button(36), `<button data-slot="tabs-trigger" style="height:32px">Tab</button>`),
    flagged: false,
  },
  {
    name: "controls agreeing on one row",
    html: row(button(36), input(36)),
    flagged: false,
  },
  {
    name: "mismatched controls on separate wrapped lines",
    // 120px cannot hold both 100px items, so each renders on its own line.
    html: `<div style="display:flex;flex-wrap:wrap;width:120px">
      <button data-slot="button" style="box-sizing:border-box;height:36px;width:100px">A</button>
      <input data-slot="input" style="box-sizing:border-box;height:28px;width:100px" />
    </div>`,
    flagged: false,
  },
  {
    name: "mismatched controls stacked in a column",
    html: `<div style="display:flex;flex-direction:column">${button(36)}${input(28)}</div>`,
    flagged: false,
  },
  {
    name: "a glyph-sized icon beside a control",
    html: row(`<svg width="16" height="16"></svg>`, button(36)),
    flagged: false,
  },
  {
    name: "a heading beside its count",
    html: row(
      `<h2 style="margin:0;font-size:20px;line-height:24px">My apps</h2>`,
      `<span style="font-size:14px;line-height:18px">9</span>`,
    ),
    flagged: false,
  },
  {
    name: "mismatched buttons, which sibling-uniformity owns",
    html: row(button(36, "A"), button(28, "B")),
    flagged: false,
  },
];

for (const { name, html, flagged } of CASES) {
  test(`row-height-uniformity ${flagged ? "flags" : "ignores"}: ${name}`, async ({ page }) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    await page.evaluate(() => document.fonts.ready);

    const violations = await page.evaluate(collectRowHeightViolations);
    const report = violations.map((v) => `  [${v.invariant}] ${v.element}\n    ${v.detail}`);

    expect(violations.length, `expected ${flagged ? 1 : 0} violation:\n${report.join("\n")}`).toBe(
      flagged ? 1 : 0,
    );
  });
}

/**
 * A stacked column of options: full-width children, so `rowsOf` never pairs
 * them and only `sibling-uniformity` has an opinion about their heights.
 */
const column = (...items: string[]) =>
  `<div style="display:flex;flex-direction:column;gap:8px;width:320px">${items.join("")}</div>`;

const option = (h: number, wraps: boolean, label: string) =>
  `<button data-slot="button" style="box-sizing:border-box;height:${h}px;width:100%;white-space:${
    wraps ? "normal" : "nowrap"
  }">${label}</button>`;

const SIBLING_CASES: { name: string; html: string; flagged: boolean }[] = [
  {
    name: "fixed-step siblings disagreeing",
    html: column(option(28, false, "A"), option(36, false, "B")),
    flagged: true,
  },
  {
    // The carve-out. A wrapping option is as tall as its label needs, so a
    // stacked list holding one two-line option among single-line ones is
    // correct rather than ragged.
    name: "a wrapping option beside a fixed-step one",
    html: column(option(42, true, "A label long enough to take two lines"), option(28, false, "B")),
    flagged: false,
  },
  {
    name: "wrapping options disagreeing with each other",
    html: column(option(42, true, "Two lines"), option(28, true, "One line")),
    flagged: false,
  },
];

for (const { name, html, flagged } of SIBLING_CASES) {
  test(`sibling-uniformity ${flagged ? "flags" : "ignores"}: ${name}`, async ({ page }) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    await page.evaluate(() => document.fonts.ready);

    const all = await page.evaluate(collectButtonViolations);
    const violations = all.filter((v) => v.invariant === "sibling-uniformity");
    const report = violations.map((v) => `  [${v.invariant}] ${v.element}\n    ${v.detail}`);

    expect(violations.length, `expected ${flagged ? 1 : 0} violation:\n${report.join("\n")}`).toBe(
      flagged ? 1 : 0,
    );
  });
}

/**
 * Fixtures for the `inline-tint-fits-line-box` collector.
 *
 * Geometry is declared in px and the tint is a plain fill, so no case depends
 * on a webfont or a design token — the only thing under test is whether the
 * collector reads the relationship between a painted inline box and the line
 * rhythm around it.
 */
const prose = (line: number, chip: string) =>
  `<p style="margin:0;font-size:16px;line-height:${line}px">Backoff doubles per attempt, capped at ${chip}.</p>`;

const tint = (style: string) =>
  `<code style="background:#eee;font-size:14px;${style}">t_max</code>`;

const TINT_CASES: { name: string; html: string; flagged: boolean }[] = [
  {
    name: "an inline chip whose vertical padding outgrows the line",
    html: prose(20, tint("padding:4px 8px")),
    flagged: true,
  },
  {
    name: "an inline chip inside the line",
    html: prose(20, tint("padding:0 8px")),
    flagged: false,
  },
  {
    // Padding on an inline-block does grow the line box, so the box the
    // collector would flag is one the line has already made room for.
    name: "an inline-block chip with the same padding",
    html: prose(20, tint("display:inline-block;padding:4px 8px")),
    flagged: false,
  },
  {
    // A block that leaves line-height `normal` states no rhythm, so there is
    // nothing to hold the tint to.
    name: "a chip in a block with no declared rhythm",
    html: `<p style="margin:0;font-size:16px;line-height:normal">capped at ${tint("padding:4px 8px")}.</p>`,
    flagged: false,
  },
  {
    // The tint is the trigger, not the padding: an unfilled inline box paints
    // nothing to spill.
    name: "a padded inline box with no fill",
    html: prose(20, `<code style="font-size:14px;padding:4px 8px">t_max</code>`),
    flagged: false,
  },
];

for (const { name, html, flagged } of TINT_CASES) {
  test(`inline-tint-fits-line-box ${flagged ? "flags" : "ignores"}: ${name}`, async ({ page }) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    await page.evaluate(() => document.fonts.ready);

    const violations = await page.evaluate(collectInlineTintViolations);
    const report = violations.map((v) => `  [${v.invariant}] ${v.element}\n    ${v.detail}`);

    expect(violations.length, `expected ${flagged ? 1 : 0} violation:\n${report.join("\n")}`).toBe(
      flagged ? 1 : 0,
    );
  });
}
