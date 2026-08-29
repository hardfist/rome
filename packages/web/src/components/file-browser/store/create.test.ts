import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createFileBrowserStore } from "./create";
import type { FileBrowserConfig } from "./types";

function createTestStore(overrides: Partial<FileBrowserConfig> = {}) {
  return createFileBrowserStore({
    apiBasePath: "/api/files",
    logicalRootPath: "/projects",
    rootLabel: "projects",
    initialSelectedFolderPath: "/projects/current",
    queryClient: new QueryClient(),
    navigate: vi.fn(),
    getRouteSnapshot: () => ({ pathname: "/projects/current", search: "", hash: "" }),
    t: ((key: string) => key) as TFunction,
    embedded: false,
    ...overrides,
  });
}

describe("file-browser action selection", () => {
  it("prepares folder action paths without changing folder navigation", () => {
    const store = createTestStore();
    store.setState((state) => ({
      selection: {
        ...state.selection,
        selectedFolderPath: "/projects/current",
        selectedTreePaths: ["/projects/current"],
      },
      ui: { ...state.ui, filesPaneDrillPath: "/projects/current" },
    }));

    const paths = store
      .getState()
      .selection.prepareContextMenu({ path: "/projects/other", type: "directory" });

    expect(paths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedTreePaths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedFolderPath).toBe("/projects/current");
    expect(store.getState().ui.filesPaneDrillPath).toBe("/projects/current");
  });

  it("waits for the app confirmation dialog before discarding unsaved edits", async () => {
    const store = createTestStore();
    store.setState((state) => ({
      file: {
        ...state.file,
        selectedFile: {
          assetUrl: null,
          content: "saved",
          editable: true,
          kind: "text",
          mimeType: "text/plain",
          path: "/projects/current/notes.txt",
          size: 5,
        },
        content: "draft",
        committedContent: "saved",
        lastDiskContent: "saved",
      },
    }));

    const cancelled = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(store.getState().file.content).toBe("draft");

    const confirmed = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(true);
    await expect(confirmed).resolves.toBe(true);
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(false);
    expect(store.getState().file.content).toBe("saved");
  });
});

describe("file-browser history panel URL", () => {
  function createHistoryStore(
    overrides: Partial<FileBrowserConfig> & { navigate: FileBrowserConfig["navigate"] },
  ) {
    const store = createTestStore({
      logicalRootPath: "projects",
      initialSelectedFolderPath: "projects",
      getRouteSnapshot: () => ({ pathname: "/projects/notes.txt", search: "", hash: "" }),
      ...overrides,
    });
    store.setState((state) => ({
      selection: { ...state.selection, selectedPath: "projects/notes.txt" },
    }));
    return store;
  }

  // `route` is reassigned between the two calls the way the router re-binds it
  // per render: a store reading its first snapshot forever fails the close.
  it("puts the open panel in the URL and takes it back out on close", () => {
    const navigate = vi.fn();
    let route = { pathname: "/projects/notes.txt", search: "", hash: "" };
    const store = createHistoryStore({ navigate, getRouteSnapshot: () => route });

    store.getState().ui.setShowHistory(true);
    expect(navigate).toHaveBeenLastCalledWith("/projects/notes.txt?history=1", { replace: false });

    route = { ...route, search: "?history=1" };
    store.getState().ui.setShowHistory(false);
    expect(navigate).toHaveBeenLastCalledWith("/projects/notes.txt", { replace: false });
  });

  it("drops the panel from the URL when the selection moves", () => {
    const navigate = vi.fn();
    const store = createHistoryStore({
      navigate,
      getRouteSnapshot: () => ({
        pathname: "/projects/notes.txt",
        search: "?history=1",
        hash: "",
      }),
    });

    store.getState().selection.navigateToPath("projects/other.txt");

    expect(navigate).toHaveBeenLastCalledWith("/projects/other.txt", { replace: false });
  });

  it("leaves the URL alone for an embedded mount", () => {
    const navigate = vi.fn();
    const store = createHistoryStore({ navigate, embedded: true });

    store.getState().ui.setShowHistory(true);

    expect(store.getState().ui.showHistory).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});
