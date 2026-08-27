import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_BOND_LEVELS,
  BOND_LADDER,
  compareTimelineEntries,
  isAfterTimelineCursor,
  latestDynamic,
  normalizeBondLevel,
  parseTimelineCursor,
  timelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";

// The People surface answers through one contract — a person, and the accounts
// they are reachable at — and the two surfaces it replaced are gone: the
// `/persons` verb routes core served, and the `/api/identities` union that
// flattened people and accounts into one row shape.
//
// Pinned as an absence rather than as a 404, because a retired route comes back
// by being re-registered, not by being requested. A source guard fails on the
// import that would revive it; a request test only fails once something calls
// it. The union's helpers that outlived it — the timeline, its cursor, and the
// bond ladder — moved to `@rome/api-types/people`, so the last part of this
// file is the behaviour that had to survive the module being deleted.

const routesDir = fileURLToPath(new URL(".", import.meta.url));
const coreSrc = resolve(routesDir, "../..");
const repoRoot = resolve(coreSrc, "../../..");
const apiTypesSrc = resolve(repoRoot, "packages/api-types/src");

/** The verb surface `/api/people` and `/api/accounts` replaced, plus the union
 *  route that answered for both nouns at once. */
const RETIRED_PATHS = [
  "/api/identities",
  "/api/persons",
  "/persons/create",
  "/persons/link",
  "/persons/mark-stranger",
  "/persons/unknown",
];

/** Every module core ships, tests excluded: a test naming a retired path is
 *  asserting its absence — this file does — and would otherwise be read as the
 *  thing it is guarding against. */
function sourceFiles(path: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return null;
    }
  })();
  if (entries === null) {
    return [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.") ? [path] : [];
  }
  return entries.flatMap((entry) => sourceFiles(resolve(path, entry.name)));
}

const offendersUnder = (root: string, needle: string) =>
  sourceFiles(root)
    .filter((path) => readFileSync(path, "utf8").includes(needle))
    .map((path) => relative(repoRoot, path))
    .sort();

describe("retired persons routes", () => {
  it("ships no route module for either retired surface", () => {
    expect(
      ["persons.ts", "identities.ts"].filter((name) => existsSync(resolve(routesDir, name))),
    ).toEqual([]);
  });

  it("registers neither on the API router", () => {
    const index = readFileSync(resolve(coreSrc, "api/index.ts"), "utf8");

    expect(index).not.toMatch(/personsRoutes|identitiesRoutes/);
  });

  it.each(RETIRED_PATHS)("names %s nowhere in core", (path) => {
    expect(offendersUnder(coreSrc, path)).toEqual([]);
  });
});

describe("retired identities module", () => {
  it("is no longer published from @rome/api-types", () => {
    const require = createRequire(import.meta.url);
    const { exports } = require(resolve(repoRoot, "packages/api-types/package.json")) as {
      exports: Record<string, string>;
    };

    expect(Object.keys(exports)).not.toContain("./identities");
    expect(existsSync(resolve(apiTypesSrc, "identities.ts"))).toBe(false);
  });

  it("is imported by nothing in core or in the contract package", () => {
    expect(offendersUnder(coreSrc, "@rome/api-types/identities")).toEqual([]);
    expect(offendersUnder(apiTypesSrc, "./identities.js")).toEqual([]);
  });

  it("exports none of the union's types or row helpers from anywhere", () => {
    // The union's own vocabulary — a row that is a person or an account
    // depending on the prefix of its id, and the counts and pages over it.
    // These are the shapes the two-noun contract replaced, so a re-export under
    // any module would put the flattened row back in the type surface.
    const UNION_SYMBOLS = [
      "IdentityRow",
      "IdentityPage",
      "IdentityCounts",
      "IdentityChannel",
      "IdentityFilterLevel",
      "ParsedIdentityId",
      "sliceIdentityPage",
      "compareIdentityRows",
      "identityMatchesQuery",
      "identityMatchesLevel",
      "countIdentities",
      "parseIdentityId",
      "personIdentityId",
      "channelIdentityId",
    ];

    for (const symbol of UNION_SYMBOLS) {
      expect({ symbol, files: offendersUnder(apiTypesSrc, symbol) }).toEqual({ symbol, files: [] });
      expect({ symbol, files: offendersUnder(coreSrc, symbol) }).toEqual({ symbol, files: [] });
    }
  });
});

describe("what the union left behind", () => {
  // The three families the people contract still needs, now that they have no
  // other home. Read through `@rome/api-types/people` because that is the only
  // module left that can offer them, and asserted by behaviour rather than by
  // presence: a re-export that lost its implementation would still typecheck.
  const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
    source: "whatsapp",
    timestamp: 1_700_000_000,
    body: "hello",
    direction: "inbound",
    ref: "chat:1",
    ...over,
  });

  it("orders a timeline newest first, totally", () => {
    const older = entry({ timestamp: 1_699_999_000, ref: "chat:0" });
    const sameSecond = entry({ direction: "outbound", ref: "chat:2" });

    expect(compareTimelineEntries(entry(), older)).toBeLessThan(0);
    // Whole-second collisions are settled past the timestamp, or a cursor could
    // not name a position in the order.
    expect(compareTimelineEntries(entry(), sameSecond)).toBeGreaterThan(0);
    expect(compareTimelineEntries(entry(), entry())).toBe(0);
  });

  it("round-trips a timeline cursor through the position it names", () => {
    const last = entry({ source: "whats|app", ref: "chat:1|2" });
    const parsed = parseTimelineCursor(timelineCursor(last));

    // Escaped part by part: a producer names itself, so neither source nor ref
    // can be trusted to leave the separator alone.
    expect(parsed).toMatchObject({
      source: "whats|app",
      ref: "chat:1|2",
      timestamp: last.timestamp,
      direction: last.direction,
    });
    expect(parseTimelineCursor("nonsense")).toBeNull();
    expect(isAfterTimelineCursor(entry({ timestamp: 1_699_999_000 }), parsed!)).toBe(true);
    expect(isAfterTimelineCursor(entry({ timestamp: 1_700_000_001 }), parsed!)).toBe(false);
  });

  it("reads a row's latest dynamic off the head of its own timeline", () => {
    expect(latestDynamic([entry(), entry({ timestamp: 1 })])).toEqual({
      source: "whatsapp",
      timestamp: 1_700_000_000,
      preview: "hello",
    });
    expect(latestDynamic([])).toBeNull();
  });

  it("keeps the bond ladder and its normalization", () => {
    expect([...BOND_LADDER]).toEqual([
      "unknown",
      "guardian",
      "inner-circle",
      "acquaintance",
      "other",
      "stranger",
    ]);
    expect([...ASSIGNABLE_BOND_LEVELS]).toEqual(["inner-circle", "acquaintance", "other"]);
    // The column is free text and older rows carry levels off today's ladder,
    // so every reader has to bucket them the same way.
    expect(normalizeBondLevel("colleague")).toBe("other");
    expect(normalizeBondLevel("unknown")).toBe("other");
    expect(normalizeBondLevel("stranger")).toBe("other");
    expect(normalizeBondLevel("inner-circle")).toBe("inner-circle");
  });
});
