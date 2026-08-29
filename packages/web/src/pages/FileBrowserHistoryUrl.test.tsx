// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import MemoryPage from "./MemoryPage";
import ProjectsPage from "./ProjectsPage";

// The editor and the watch stream are the only two things a file browser needs
// that jsdom cannot supply; neither is under test here.
vi.mock("@/components/monaco-file-editor", () => ({
  MonacoFileEditor: () => <div data-testid="editor" />,
}));

class StubEventSource {
  readonly close = vi.fn();
  addEventListener() {}
  removeEventListener() {}
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const COMMIT_MESSAGE = "Record the second draft";

/** Serves the probes a file browser fires while opening one file. */
function mockBackend(apiBasePath: string, filePath: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
    if (url.startsWith(`${apiBasePath}/history`)) {
      return ok([{ date: "2026-08-01T00:00:00Z", hash: "abc1234def", message: COMMIT_MESSAGE }]);
    }
    if (url.startsWith(`${apiBasePath}/resolve`)) return ok({ path: filePath, type: "file" });
    if (url.startsWith(`${apiBasePath}/file`)) {
      return ok({
        assetUrl: null,
        content: "second draft",
        editable: true,
        kind: "text",
        mimeType: "text/plain",
        path: filePath,
        size: 12,
      });
    }
    return ok([]); // /tree
  }) as typeof fetch);
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function renderHostRoute(route: string, initialUrl: string, page: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <LocationProbe />
        <Routes>
          <Route path={route} element={page} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function historyRequests(apiBasePath: string): string[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => String(input))
    .filter((url) => url.startsWith(`${apiBasePath}/history`));
}

describe("the file-browser history panel has a URL", () => {
  it("renders the panel for the URL's file on /memory in a fresh session", async () => {
    mockBackend("/api/memory", "memory/notes.txt");
    renderHostRoute("/memory/*", "/memory/notes.txt?history=1", <MemoryPage />);

    const panel = await screen.findByRole("region", { name: "Git History" });
    expect(panel.textContent).toContain(COMMIT_MESSAGE);
    await waitFor(() =>
      expect(historyRequests("/api/memory")).toContain(
        "/api/memory/history?path=memory%2Fnotes.txt",
      ),
    );
  });

  it("renders the panel for the URL's file on /projects in a fresh session", async () => {
    mockBackend("/api/projects", "projects/app/README.txt");
    renderHostRoute("/projects/*", "/projects/app/README.txt?history=1", <ProjectsPage />);

    const panel = await screen.findByRole("region", { name: "Git History" });
    expect(panel.textContent).toContain(COMMIT_MESSAGE);
    await waitFor(() =>
      expect(historyRequests("/api/projects")).toContain(
        "/api/projects/history?path=projects%2Fapp%2FREADME.txt",
      ),
    );
  });

  it("does not open the panel for a plain file URL", async () => {
    mockBackend("/api/memory", "memory/notes.txt");
    renderHostRoute("/memory/*", "/memory/notes.txt", <MemoryPage />);

    await screen.findByTestId("editor");
    expect(screen.queryByRole("region", { name: "Git History" })).toBeNull();
    expect(historyRequests("/api/memory")).toEqual([]);
  });

  it("moves the address bar as the panel toggles, and closes on back", async () => {
    mockBackend("/api/memory", "memory/notes.txt");
    renderHostRoute("/memory/*", "/memory/notes.txt", <MemoryPage />);
    const location = () => screen.getByTestId("location").textContent;

    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("region", { name: "Git History" });
    expect(location()).toBe("/memory/notes.txt?history=1");

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Git History" })).toBeNull());
    expect(location()).toBe("/memory/notes.txt");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("region", { name: "Git History" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Git History" })).toBeNull());
    expect(location()).toBe("/memory/notes.txt");
  });
});
