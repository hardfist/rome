import { describe, expect, it } from "vitest";
import {
  getFileBrowserDirectoryAncestors,
  getFileBrowserRouteLogicalPath,
  getFileBrowserUrlLocation,
  getFileBrowserUrlPath,
  isFileBrowserHistoryUrl,
  shouldSyncRootPanelTriggerUrl,
} from "./file-browser-routing";

describe("file browser routing", () => {
  it("maps selected logical paths to tab-relative URLs", () => {
    expect(getFileBrowserUrlPath("projects", "projects/app/src/index.ts")).toBe(
      "/projects/app/src/index.ts",
    );
    expect(getFileBrowserUrlPath("memory", "memory/Research Notes.md")).toBe(
      "/memory/Research%20Notes.md",
    );
    expect(getFileBrowserUrlPath("projects", null)).toBe("/projects");
  });

  it("maps route splats back to logical paths", () => {
    expect(getFileBrowserRouteLogicalPath("projects", "app/src/index.ts")).toBe(
      "projects/app/src/index.ts",
    );
    expect(getFileBrowserRouteLogicalPath("memory", "Research%20Notes.md")).toBe(
      "memory/Research Notes.md",
    );
    expect(getFileBrowserRouteLogicalPath("memory", undefined)).toBeNull();
  });

  it("rejects unsafe route segments", () => {
    expect(getFileBrowserRouteLogicalPath("projects", "../secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app//secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app\\secret.txt")).toBeNull();
    expect(getFileBrowserRouteLogicalPath("projects", "app%2Fsecret.txt")).toBeNull();
  });

  it("returns directory ancestors for tree expansion", () => {
    expect(getFileBrowserDirectoryAncestors("projects/app/src/index.ts", "projects")).toEqual([
      "projects/app",
      "projects/app/src",
    ]);
    expect(getFileBrowserDirectoryAncestors("memory/IDENTITY.md", "memory")).toEqual([]);
  });

  it("gives the open history panel a URL and drops it when closed", () => {
    const route = { pathname: "/memory/Research%20Notes.md", search: "", hash: "" };
    expect(
      getFileBrowserUrlLocation("memory", "memory/Research Notes.md", {
        route,
        showHistory: true,
      }),
    ).toBe("/memory/Research%20Notes.md?history=1");
    expect(
      getFileBrowserUrlLocation("memory", "memory/Research Notes.md", {
        route: { ...route, search: "?history=1" },
      }),
    ).toBe("/memory/Research%20Notes.md");
  });

  it("carries hideSidebar across history toggles and drops every other param", () => {
    expect(
      getFileBrowserUrlLocation("projects", "projects/app/README.md", {
        route: { pathname: "/projects/app/README.md", search: "?hideSidebar=1&stale=x", hash: "" },
        showHistory: true,
      }),
    ).toBe("/projects/app/README.md?hideSidebar=1&history=1");
    expect(
      getFileBrowserUrlLocation("projects", null, {
        route: { pathname: "/projects", search: "?hideSidebar=1", hash: "" },
      }),
    ).toBe("/projects?hideSidebar=1");
  });

  it("keeps an anchor within its own document and drops it on the way out", () => {
    const route = { pathname: "/memory/notes.md", search: "", hash: "#section-2" };
    expect(
      getFileBrowserUrlLocation("memory", "memory/notes.md", { route, showHistory: true }),
    ).toBe("/memory/notes.md?history=1#section-2");
    expect(getFileBrowserUrlLocation("memory", "memory/other.md", { route })).toBe(
      "/memory/other.md",
    );
  });

  it("reads the history panel out of a route's query", () => {
    expect(isFileBrowserHistoryUrl("?history=1")).toBe(true);
    expect(isFileBrowserHistoryUrl("?hideSidebar=1&history=1")).toBe(true);
    expect(isFileBrowserHistoryUrl("?history=0")).toBe(false);
    expect(isFileBrowserHistoryUrl("")).toBe(false);
  });

  it("syncs the root panel trigger URL only on desktop", () => {
    expect(shouldSyncRootPanelTriggerUrl(true)).toBe(true);
    expect(shouldSyncRootPanelTriggerUrl(false)).toBe(false);
  });
});
