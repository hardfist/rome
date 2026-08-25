import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTemplateVersions, TEMPLATED_PACKAGES } from "./template-versions.js";

function registryResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveTemplateVersions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a caret range on the newest published version of each package", async () => {
    const byUrl: Record<string, string> = {
      "@rome-os%2fapp-runtime": "0.6.0",
      "@rome-os%2fapp-web-sdk": "0.2.21",
      "@rome-os%2fui": "0.2.2",
    };
    vi.stubGlobal("fetch", (url: string) => {
      const key = Object.keys(byUrl).find((k) => url.includes(k));
      return Promise.resolve(registryResponse(byUrl[key as string]));
    });

    await expect(resolveTemplateVersions()).resolves.toEqual({
      "@rome-os/app-runtime": "^0.6.0",
      "@rome-os/app-web-sdk": "^0.2.21",
      "@rome-os/ui": "^0.2.2",
    });
  });

  it("falls back rather than failing the scaffold when the registry is unreachable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("getaddrinfo ENOTFOUND")));

    const versions = await resolveTemplateVersions();
    for (const pkg of TEMPLATED_PACKAGES) {
      expect(versions[pkg]).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });

  it("falls back per package, so one bad lookup does not pin the others back", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        url.includes("%2fui") ? new Response("nope", { status: 500 }) : registryResponse("9.9.9"),
      ),
    );

    const versions = await resolveTemplateVersions();
    expect(versions["@rome-os/app-runtime"]).toBe("^9.9.9");
    expect(versions["@rome-os/app-web-sdk"]).toBe("^9.9.9");
    expect(versions["@rome-os/ui"]).not.toBe("^9.9.9");
  });

  it("ignores a registry document with no usable version", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );

    const versions = await resolveTemplateVersions();
    expect(versions["@rome-os/ui"]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });
});
