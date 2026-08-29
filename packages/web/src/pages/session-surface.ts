// Surfaces that open over a session's detail view. Each is a view in its own
// right — the details sheet and the trace drawer both carry content a user can
// return to or share — so each gets a URL under the session's own path and
// renders from that URL alone (docs/northstars/view-urls.md).
export type SessionSurface =
  | { kind: "chat" }
  | { kind: "details" }
  | { kind: "messageTrace"; messageId: string }
  | { kind: "turnTrace"; turnId: string };

export const SESSIONS_ROUTE_BASE = "/sessions";
// show_app addresses the sessions app through /full/apps/sessions, so the same
// session surface has one path under each mount.
export const SESSIONS_FULL_ROUTE_BASE = "/full/apps/sessions";

// Answers which of the two mounts a location sits under, and defaults to
// /sessions for anything else, so a caller can build a path without knowing
// which one rendered it.
export function sessionsBasePath(pathname: string): string {
  return pathname.startsWith(SESSIONS_FULL_ROUTE_BASE)
    ? SESSIONS_FULL_ROUTE_BASE
    : SESSIONS_ROUTE_BASE;
}

// `splat` is the `*` param of the `:sessionId/*` route, which React Router
// hands back decoded — including an escaped slash, so an identifier carrying
// one splits into extra segments and claims no surface. A path no surface
// claims reads as the chat surface, so an old or mistyped URL still renders
// the session.
export function parseSessionSurface(splat: string | undefined): SessionSurface {
  const segments = (splat ?? "").split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "details") return { kind: "details" };
  if (segments.length === 3 && segments[2] === "trace") {
    if (segments[0] === "messages") return { kind: "messageTrace", messageId: segments[1] };
    if (segments[0] === "turns") return { kind: "turnTrace", turnId: segments[1] };
  }
  return { kind: "chat" };
}

export function sessionPath(basePath: string, sessionId: string): string {
  return `${basePath}/${encodeURIComponent(sessionId)}`;
}

export function sessionSurfacePath(
  basePath: string,
  sessionId: string,
  surface: SessionSurface,
): string {
  const session = sessionPath(basePath, sessionId);
  switch (surface.kind) {
    case "details":
      return `${session}/details`;
    case "messageTrace":
      return `${session}/messages/${encodeURIComponent(surface.messageId)}/trace`;
    case "turnTrace":
      return `${session}/turns/${encodeURIComponent(surface.turnId)}/trace`;
    case "chat":
      return session;
  }
}
