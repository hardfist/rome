import { describe, expect, it } from "vitest";
import {
  parseSessionSurface,
  sessionPath,
  sessionsBasePath,
  sessionSurfacePath,
  SESSIONS_FULL_ROUTE_BASE,
  SESSIONS_ROUTE_BASE,
} from "./session-surface";

describe("parseSessionSurface", () => {
  it("reads the bare session route as the chat surface", () => {
    expect(parseSessionSurface(undefined)).toEqual({ kind: "chat" });
    expect(parseSessionSurface("")).toEqual({ kind: "chat" });
    expect(parseSessionSurface("/")).toEqual({ kind: "chat" });
  });

  it("reads the details, message-trace and turn-trace routes", () => {
    expect(parseSessionSurface("details")).toEqual({ kind: "details" });
    expect(parseSessionSurface("messages/msg-1/trace")).toEqual({
      kind: "messageTrace",
      messageId: "msg-1",
    });
    expect(parseSessionSurface("turns/turn-1/trace")).toEqual({
      kind: "turnTrace",
      turnId: "turn-1",
    });
  });

  it("falls back to the chat surface for a route it does not name", () => {
    expect(parseSessionSurface("nonsense")).toEqual({ kind: "chat" });
    expect(parseSessionSurface("messages/msg-1")).toEqual({ kind: "chat" });
    expect(parseSessionSurface("turns/turn-1/segments")).toEqual({ kind: "chat" });
  });
});

describe("sessionSurfacePath", () => {
  it("round-trips every surface through its path", () => {
    const surfaces = [
      { kind: "chat" } as const,
      { kind: "details" } as const,
      { kind: "messageTrace", messageId: "msg-1" } as const,
      { kind: "turnTrace", turnId: "turn-1" } as const,
    ];
    for (const surface of surfaces) {
      const path = sessionSurfacePath(SESSIONS_ROUTE_BASE, "session-1", surface);
      expect(parseSessionSurface(path.slice(`${SESSIONS_ROUTE_BASE}/session-1/`.length))).toEqual(
        surface,
      );
    }
  });

  it("escapes the identifiers it puts in a path", () => {
    expect(sessionSurfacePath(SESSIONS_ROUTE_BASE, "s/1", { kind: "details" })).toBe(
      "/sessions/s%2F1/details",
    );
    expect(
      sessionSurfacePath(SESSIONS_ROUTE_BASE, "s1", { kind: "messageTrace", messageId: "m/1" }),
    ).toBe("/sessions/s1/messages/m%2F1/trace");
  });

  it("builds under whichever base the page is mounted on", () => {
    expect(sessionPath(SESSIONS_FULL_ROUTE_BASE, "s1")).toBe("/full/apps/sessions/s1");
    expect(
      sessionSurfacePath(SESSIONS_FULL_ROUTE_BASE, "s1", { kind: "turnTrace", turnId: "t1" }),
    ).toBe("/full/apps/sessions/s1/turns/t1/trace");
  });
});

describe("sessionsBasePath", () => {
  it("picks the mount the current location sits under", () => {
    expect(sessionsBasePath("/sessions/s1/details")).toBe(SESSIONS_ROUTE_BASE);
    expect(sessionsBasePath("/full/apps/sessions/s1/details")).toBe(SESSIONS_FULL_ROUTE_BASE);
  });
});
