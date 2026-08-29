import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `/api/linkedin/threads*` and `/api/linkedin/participants` are retired.
 *
 * They served one reader: the People page's LinkedIn section, which existed
 * only for as long as a LinkedIn thread resolved to no person. LinkedIn has an
 * accounts plane now — it joins the directory fold and the account stream, and
 * its direct threads feed a person's timeline through `personMessageStores` the
 * way WhatsApp's do — so the dashboard reads LinkedIn through `/api/people` and
 * `/api/accounts` like every other channel, and the mirror views have nobody
 * left to answer.
 *
 * The mirror itself stays. The inbox poller keeps filling it and
 * `LinkedInStoreRepository` keeps serving the readers that fold and time-line
 * it; what goes is the HTTP surface that only the deleted section called.
 *
 * A route file with no caller is not inert — it is a live endpoint that answers
 * a mirror read to anything that finds it, including a send that reaches
 * LinkedIn through opencli. So this pins the deletion rather than trusting the
 * absence of callers.
 */

const routesRoot = fileURLToPath(new URL(".", import.meta.url));
const coreSrc = resolve(routesRoot, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return extname(path) === ".ts" ? [path] : [];
  });
}

const sources = sourceFiles(coreSrc).filter(
  (path) => !path.endsWith("linkedin-threads-retired.test.ts"),
);

function hits(pattern: RegExp): string[] {
  return sources.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(pattern)].map((match) => `${relative(coreSrc, path)}:${match[0]}`);
  });
}

describe("the LinkedIn mirror routes", () => {
  it("have no module left behind", () => {
    expect(existsSync(resolve(routesRoot, "linkedin-threads.ts"))).toBe(false);
    expect(existsSync(resolve(routesRoot, "linkedin-threads.test.ts"))).toBe(false);
  });

  it("are registered on no app", () => {
    expect(hits(/linkedinThreadsRoutes|routes\/linkedin-threads/g)).toEqual([]);
  });

  it("leave no handler for their paths", () => {
    expect(hits(/["'`]\/linkedin\/(?:threads|participants)/g)).toEqual([]);
    expect(hits(/\/api\/linkedin\/(?:threads|participants)/g)).toEqual([]);
  });

  it("keep the mirror they read, which other readers still need", () => {
    // The line the cut stops at: the store and the poller behind it stay, so a
    // LinkedIn message still reaches a person's timeline.
    expect(existsSync(resolve(coreSrc, "db/repositories/linkedin-store.ts"))).toBe(true);
    expect(existsSync(resolve(coreSrc, "channels/linkedin.ts"))).toBe(true);
    expect(readFileSync(resolve(coreSrc, "people/timeline-sources.ts"), "utf8")).toContain(
      "linkedInMessages",
    );
  });
});
