import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handlers } from "../../../mock/handlers";
import * as peopleMock from "../../../mock/handlers/people";

// Mock mode's half of the same retirement the route side pins
// (`packages/core/src/api/routes/retired-identity-surface.test.ts`): the
// dashboard's backend stand-in answers the /people contract and nothing else.
//
// Two things had to go together. The `/api/identities` and `/api/persons*`
// handlers, because a mock that still answers a route core deleted is a page
// that can be built against a surface production does not have. And
// `proposedApiStore` — the escape hatch that handed the fixture store from the
// legacy handlers to the contract ones — because with the legacy handlers gone
// there is one implementation, so the store is a module it imports rather than
// something reached around the side of another handler file.

const peopleRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(peopleRoot, "../../..");

/** Every path family the /people contract replaced. */
const RETIRED_PREFIXES = ["/api/identities", "/api/persons"];

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
  if (path.endsWith("node_modules") || path.endsWith("dist")) return [];
  return entries.flatMap((entry) => sourceFiles(resolve(path, entry.name)));
}

const webSources = () => [
  ...sourceFiles(resolve(webRoot, "src")),
  ...sourceFiles(resolve(webRoot, "mock")),
];

const offenders = (needle: string) =>
  webSources()
    .filter((path) => readFileSync(path, "utf8").includes(needle))
    .map((path) => relative(webRoot, path))
    .sort();

/** The path every registered handler matches, however it was registered. */
const registeredPaths = () =>
  handlers.map((handler) => String((handler as { info: { path: unknown } }).info.path));

describe("mock backend after the retirement", () => {
  it.each(RETIRED_PREFIXES)("registers no %s handler", (prefix) => {
    expect(registeredPaths().filter((path) => path.startsWith(prefix))).toEqual([]);
  });

  it("still serves the contract that replaced them", () => {
    // The absence above is only worth anything while the replacement is there:
    // a mock that answers neither surface would pass every assertion in this
    // file and serve the dashboard nothing.
    const paths = registeredPaths();

    expect(paths).toContain("/api/people");
    expect(paths).toContain("/api/people/:id");
    expect(paths).toContain("/api/people/:id/messages");
    expect(paths).toContain("/api/accounts");
  });

  it("hands the fixture store over as a module, not an escape hatch", () => {
    expect(peopleMock).not.toHaveProperty("proposedApiStore");
    expect(offenders("proposedApiStore")).toEqual([]);
  });
});

describe("web sources after the retirement", () => {
  it.each(RETIRED_PREFIXES)("names %s nowhere", (prefix) => {
    expect(offenders(prefix)).toEqual([]);
  });

  it("imports nothing from the retired identities module", () => {
    expect(offenders("@rome/api-types/identities")).toEqual([]);
  });
});
