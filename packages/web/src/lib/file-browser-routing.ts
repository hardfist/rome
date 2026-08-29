export function decodeFileBrowserRoutePath(routePath: string | undefined): string | null {
  if (!routePath) return null;

  const normalizedPath = routePath.replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) return null;

  let segments: string[];
  try {
    segments = normalizedPath.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    return null;
  }

  return segments.join("/");
}

export function getFileBrowserRouteLogicalPath(
  logicalRootPath: string,
  routePath: string | undefined,
): string | null {
  const decodedPath = decodeFileBrowserRoutePath(routePath);
  return decodedPath ? `${logicalRootPath}/${decodedPath}` : null;
}

export function getFileBrowserUrlPath(logicalRootPath: string, path: string | null): string {
  if (!path || path === logicalRootPath) {
    return `/${logicalRootPath}`;
  }

  const relativePath = path.startsWith(`${logicalRootPath}/`)
    ? path.slice(logicalRootPath.length + 1)
    : path;
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `/${logicalRootPath}/${encodedPath}`;
}

export function shouldSyncRootPanelTriggerUrl(isDesktopViewport: boolean): boolean {
  return isDesktopViewport;
}

export function getFileBrowserDirectoryAncestors(path: string, logicalRootPath: string): string[] {
  if (path === logicalRootPath || !path.startsWith(`${logicalRootPath}/`)) {
    return [];
  }

  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join("/"));
  }
  return ancestors;
}

/**
 * The canonical location for a selection: pathname, then the query the next
 * view keeps. `hideSidebar` outlives navigation; the open history panel is a
 * view of its own (`docs/northstars/view-urls.md`) and so rides the URL too.
 * Every other param is dropped, which is what closes the panel whenever the
 * selection moves. The hash survives only within one document, since an anchor
 * means nothing in the next file.
 */
export function getFileBrowserUrlLocation(
  logicalRootPath: string,
  path: string | null,
  opts: { route: { pathname: string; search: string; hash: string }; showHistory?: boolean },
): string {
  const pathname = getFileBrowserUrlPath(logicalRootPath, path);
  const next = new URLSearchParams();
  if (new URLSearchParams(opts.route.search).get("hideSidebar") === "1") {
    next.set("hideSidebar", "1");
  }
  if (opts.showHistory) {
    next.set("history", "1");
  }
  const query = next.toString();
  const hash = pathname === opts.route.pathname ? opts.route.hash : "";
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export function isFileBrowserHistoryUrl(search: string): boolean {
  return new URLSearchParams(search).get("history") === "1";
}
