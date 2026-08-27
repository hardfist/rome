// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

// The Toaster mounts in App.tsx, outside this tree — spy on the calls instead.
vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => "toast-id"),
    {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      dismiss: vi.fn(),
    },
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface AppKeysCall {
  method: string;
  url: string;
  body: unknown;
}

function mockAppKeysFetch(
  loadKeys: () => Response | Promise<Response>,
  onWrite?: (call: AppKeysCall) => Response | Promise<Response>,
): AppKeysCall[] {
  const writes: AppKeysCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/settings") return ok({});
    if (url === "/api/tailscale/devices") {
      return ok({ mode: "oauth", configured: false, devices: [] });
    }
    if (url === "/api/integrations/composio/status") return ok({});
    if (url === "/api/connections") return ok({ connections: [] });
    if (url.startsWith("/api/app-keys")) {
      if (method === "GET") return loadKeys();
      const call: AppKeysCall = {
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      writes.push(call);
      if (onWrite) return onWrite(call);
      return ok({ ok: true, overridden: false });
    }
    return ok({});
  }) as typeof fetch);
  return writes;
}

function renderConnectionsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/connections"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const storedKey = {
  name: "SHOP_DB_PASSWORD",
  label: "My shop database password",
  updatedAt: "2026-08-27T00:00:00.000Z",
  overridden: false,
};

describe("Settings app keys section", () => {
  it("lists stored keys with label, name, and a Set badge — never the value", async () => {
    mockAppKeysFetch(() => ok({ keys: [storedKey] }));

    renderConnectionsSettings();

    expect(await screen.findByRole("heading", { level: 2, name: "App keys" })).toBeTruthy();
    expect(await screen.findByText("My shop database password")).toBeTruthy();
    expect(screen.getByText("SHOP_DB_PASSWORD")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
  });

  it("shows the empty state when no keys exist", async () => {
    mockAppKeysFetch(() => ok({ keys: [] }));

    renderConnectionsSettings();

    expect(await screen.findByText("No app keys yet")).toBeTruthy();
  });

  it("saves a new key through the add form with the all-apps consent visible", async () => {
    const writes = mockAppKeysFetch(() => ok({ keys: [] }));

    renderConnectionsSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));

    expect(
      screen.getByText("Any app installed on your Rome will be able to read this."),
    ).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText("What is this key for?"),
      "My shop database password",
    );
    await userEvent.type(screen.getByLabelText("Name apps use"), "shop_db_password");
    await userEvent.type(screen.getByLabelText("Secret value"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved. Apps can now read SHOP_DB_PASSWORD."),
    );
    expect(writes).toHaveLength(1);
    // The name input upcases as the user types.
    expect(writes[0].url).toBe("/api/app-keys/SHOP_DB_PASSWORD");
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].body).toEqual({
      label: "My shop database password",
      value: "hunter2",
    });
  });

  it("rejects a reserved name client-side without calling the API", async () => {
    const writes = mockAppKeysFetch(() => ok({ keys: [] }));

    renderConnectionsSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Add key" }));
    await userEvent.type(screen.getByLabelText("Name apps use"), "ROME_PROFILE");
    await userEvent.type(screen.getByLabelText("Secret value"), "v");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    expect(
      await screen.findByText(
        "Names starting with ROME_ are reserved by Rome. Pick a different name.",
      ),
    ).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("removes a key after confirmation", async () => {
    const writes = mockAppKeysFetch(
      () => ok({ keys: [storedKey] }),
      () => ok({ ok: true }),
    );

    renderConnectionsSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove SHOP_DB_PASSWORD?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Removed SHOP_DB_PASSWORD."));
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("DELETE");
    expect(writes[0].url).toBe("/api/app-keys/SHOP_DB_PASSWORD");
  });

  it("marks an operator-overridden key and warns on save", async () => {
    mockAppKeysFetch(
      () => ok({ keys: [{ ...storedKey, overridden: true }] }),
      () => ok({ ok: true, overridden: true }),
    );

    renderConnectionsSettings();

    expect(await screen.findByText("Overridden by server settings")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    // Replace locks the name and only asks for a new value.
    expect((screen.getByLabelText("Name apps use") as HTMLInputElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Secret value"), "new-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save for all apps" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Saved, but a server setting with the same name takes precedence — the value you entered is not in use.",
      ),
    );
  });
});
