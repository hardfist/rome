import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The People page reads and writes the /people contract, and nothing else. The
// composer retired its own `/api/persons` read behind the same guard
// (`components/chat/chat-people-endpoint.test.ts`); the page's writes were the
// last thing keeping the legacy routes alive, so this pins their absence rather
// than trusting a repointed call site not to come back.
//
// A path rather than a request: the union page fanned one gesture out over
// several routes, so counting requests in a rendered test proves only that the
// path the test walked stayed clean.

const peopleRoot = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(peopleRoot, "..");
const webSrc = resolve(pagesRoot, "..");

/** Every module the People surface is built from. */
const PEOPLE_SURFACES = [
  peopleRoot,
  resolve(pagesRoot, "PeoplePage.tsx"),
  resolve(pagesRoot, "PersonDetailPage.tsx"),
];

/** The LinkedIn mirror is not on this contract: its threads are conversations
 *  rather than accounts, and it reads its own endpoints until a LinkedIn
 *  account can be linked to a person. */
const NOT_ON_THE_CONTRACT = ["linkedin.tsx", "legacy-api-shapes.ts"];

function sourceFiles(path: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return null;
    }
  })();
  if (entries === null) {
    const isSource = [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.");
    return isSource && !NOT_ON_THE_CONTRACT.some((name) => path.endsWith(name)) ? [path] : [];
  }
  return entries.flatMap((entry) => sourceFiles(resolve(path, entry.name)));
}

describe("People surface endpoints", () => {
  it("names no legacy /api/persons route", () => {
    const offenders = PEOPLE_SURFACES.flatMap(sourceFiles).filter((path) =>
      readFileSync(path, "utf8").includes("/api/persons"),
    );

    expect(offenders.map((path) => relative(webSrc, path)).sort()).toEqual([]);
  });

  it("names no identity union route either", () => {
    // `/api/identities` was the union this rebuild replaced. It reads the same
    // rows through one flattened noun, so a surface still on it would be a
    // second answer to the same question.
    const offenders = PEOPLE_SURFACES.flatMap(sourceFiles).filter((path) =>
      readFileSync(path, "utf8").includes("/api/identities"),
    );

    expect(offenders.map((path) => relative(webSrc, path)).sort()).toEqual([]);
  });
});
