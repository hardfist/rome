import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The composer reads curated people from `GET /api/people`. `/api/persons` is
// the legacy route it used to read, kept alive only by the People page's
// writes, and a second decode site is what would keep it from retiring — so
// this pins the absence rather than trusting the one call site not to come
// back.

const chatRoot = fileURLToPath(new URL(".", import.meta.url));
const webSrc = resolve(chatRoot, "../..");

/** Every module the composer is built from, plus the chat client it calls. */
const COMPOSER_SURFACES = [chatRoot, resolve(webSrc, "hooks"), resolve(webSrc, "lib/chat-api.ts")];

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

describe("composer people endpoint", () => {
  it("reads no composer surface off the legacy /api/persons route", () => {
    const offenders = COMPOSER_SURFACES.flatMap(sourceFiles).filter((path) =>
      readFileSync(path, "utf8").includes("/api/persons"),
    );

    expect(offenders.map((path) => relative(webSrc, path)).sort()).toEqual([]);
  });
});
