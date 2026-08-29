import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { isCancelledError, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useFileBrowserStore, useFileBrowserStoreApi } from "../store/context";
import {
  getFileBrowserRouteLogicalPath,
  isFileBrowserHistoryUrl,
} from "@/lib/file-browser-routing";

/**
 * URL-as-SSOT bridge. When the route changes, we resolve the
 * path to file/dir/missing via `/resolve`, then load it; we suppress the URL
 * push so we don't trigger another route-sync cycle.
 */
export function useUrlSelectionSync(opts: { embedded: boolean }) {
  const store = useFileBrowserStoreApi();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ "*"?: string }>();
  const queryClient = useQueryClient();
  const wildcard = params["*"];
  const historyInUrl = isFileBrowserHistoryUrl(location.search);
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const showHistory = useFileBrowserStore((s) => s.ui.showHistory);

  useEffect(() => {
    if (opts.embedded) return;
    let cancelled = false;
    const { config } = store.getState();
    const { logicalRootPath, apiBasePath } = config;
    const routeLogicalPath = getFileBrowserRouteLogicalPath(logicalRootPath, wildcard);
    const resolveQueryKey = (path: string) =>
      ["file-browser", logicalRootPath, "resolve", path] as const;

    const sync = async () => {
      const browserPath = `${location.pathname}${location.search}${location.hash}`;
      const state = store.getState();
      const path = routeLogicalPath;
      const currentSelectedPath = state.selection.selectedPath;
      const currentSelectedFolderPath = state.selection.selectedFolderPath;
      const initialFolder = config.initialSelectedFolderPath;
      const selectionAlreadyMatches =
        (!path && currentSelectedFolderPath === initialFolder) ||
        path === currentSelectedPath ||
        path === currentSelectedFolderPath;

      if (browserPath !== state.refs.acceptedBrowserPath && !selectionAlreadyMatches) {
        const canLeave = await state.file.resolveUnsavedEditsBeforeLeaving();
        if (cancelled) return;
        if (!canLeave) {
          navigate(state.refs.acceptedBrowserPath, { replace: true });
          return;
        }
        state.refs.acceptedBrowserPath = browserPath;
      } else if (browserPath !== state.refs.acceptedBrowserPath) {
        state.refs.acceptedBrowserPath = browserPath;
      }

      if (!path) {
        if (currentSelectedFolderPath === logicalRootPath) return;
        store.getState().selection.selectFolder(initialFolder, { syncUrl: false });
        return;
      }

      if (path === currentSelectedPath || path === currentSelectedFolderPath) return;

      try {
        const info = await queryClient.fetchQuery({
          queryKey: resolveQueryKey(path),
          queryFn: async () => {
            const response = await fetch(`${apiBasePath}/resolve?path=${encodeURIComponent(path)}`);
            const data = await response.json();
            if (!response.ok || !("type" in data)) {
              throw new Error("Failed to resolve path");
            }
            return data as { type: "file" | "directory" | "missing"; path: string };
          },
        });
        if (cancelled) return;

        if (info.type === "missing") {
          toast.error(config.t("status.networkError"));
          return;
        }

        await store.getState().tree.loadDirectoryAncestors(path);
        if (cancelled) return;

        if (info.type === "directory") {
          await store.getState().tree.loadPath(path);
          if (cancelled) return;
          store.getState().selection.selectFolder(path, { expand: true, syncUrl: false });
          return;
        }

        await store.getState().file.loadFile(path, { syncUrl: false });
      } catch (error) {
        if (cancelled || isCancelledError(error)) return;
        console.error("Failed to resolve route path:", error);
        toast.error(config.t("status.networkError"));
      }
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    opts.embedded,
    queryClient,
    store,
    wildcard,
  ]);

  // Opening a file clears `showHistory`, so this waits on `selectedPath` and
  // re-runs once the file the URL names has landed.
  useEffect(() => {
    if (opts.embedded) return;
    if (historyInUrl === showHistory) return;
    if (historyInUrl && !selectedPath) return;
    store.getState().ui.setShowHistory(historyInUrl, { syncUrl: false });
  }, [historyInUrl, opts.embedded, selectedPath, showHistory, store]);
}
