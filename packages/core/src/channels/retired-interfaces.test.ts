import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The shapes the channel-interface migration replaced, pinned absent.
//
// `Accounts` and `Messages` (accounts.ts, messages.ts) are the surface now, and
// every consumer moved onto them across #97 and #99. What is guarded here is
// the half that was left behind: a per-channel activity read, the record fold
// that joined it to the triage log, a separate address map, and the timeline
// seam the message stores replaced.
//
// A guard rather than trust in the deletion, because each of these is a second
// way to ask a question the surviving interface already answers — a channel
// growing one back is two sources of one truth, which is how the preview on a
// row and the page beneath it drift apart.

const channelsRoot = fileURLToPath(new URL(".", import.meta.url));
const coreSrc = resolve(channelsRoot, "..");

/** This file names every retired symbol, so it cannot be its own offender. */
const GUARD = resolve(channelsRoot, "retired-interfaces.test.ts");

const RETIRED: Array<{ name: string; pattern: RegExp }> = [
  // Substring rather than a word match, so `sqlTimelineSource` — the SQL half
  // that exists only to build these — is caught by the same guard.
  { name: "TimelineSource", pattern: /TimelineSource/ },
  { name: "TalkAccounts", pattern: /\bTalkAccounts\b/ },
  { name: "TalkAccountActivity", pattern: /\bTalkAccountActivity\b/ },
  { name: "listActivity", pattern: /\blistActivity\b/ },
  { name: "listAddresses", pattern: /\blistAddresses\b/ },
  { name: "foldAccountRecords", pattern: /\bfoldAccountRecords\b/ },
  { name: "recordFor", pattern: /\brecordFor\b/ },
  // `MirrorPlanes` deliberately survives and is not matched here: it names the
  // registry of a channel's planes, which is still a thing a fold is given.
  // What went is the singular — the per-channel plane type, now `Accounts`.
  { name: "MirrorPlane", pattern: /\bMirrorPlane\b/ },
];

function sourceFiles(path: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return null;
    }
  })();
  if (entries === null) return extname(path) === ".ts" && path !== GUARD ? [path] : [];
  return entries.flatMap((entry) => sourceFiles(resolve(path, entry.name)));
}

describe("retired channel interfaces", () => {
  const files = sourceFiles(coreSrc).map((path) => ({
    path: relative(coreSrc, path),
    text: readFileSync(path, "utf8"),
  }));

  it("reads the whole of core, so nothing is guarded by not being looked at", () => {
    // The scan is the test. A resolve that silently walked nothing would pass
    // every case below without reading a line.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path === "channels/accounts.ts")).toBe(true);
    expect(files.some((file) => file.path === "people/timeline.ts")).toBe(true);
  });

  it.each(RETIRED)("names $name nowhere — not in source, not in a test", ({ pattern }) => {
    const offenders = files.filter((file) => pattern.test(file.text));

    expect(offenders.map((file) => file.path).sort()).toEqual([]);
  });
});
