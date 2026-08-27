import {
  APP_KEY_MAX_VALUE_LENGTH,
  type AppKeyDto,
  appKeyNameError,
} from "@rome/api-types/app-keys";
import { http, HttpResponse } from "msw";

// App keys fixtures. Name validation is imported, not restated — the mock
// rejects exactly the names core rejects. `overridden` is data here: the mock
// has no process environment, so every stored key reads as live.
const store = new Map<string, { label: string; updatedAt: string }>([
  [
    "DEMO_API_KEY",
    { label: "Demo service API key", updatedAt: new Date(Date.now() - 3600_000).toISOString() },
  ],
]);

function list(): AppKeyDto[] {
  return [...store.entries()]
    .map(([name, entry]) => ({
      name,
      label: entry.label,
      updatedAt: entry.updatedAt,
      overridden: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const appKeysHandlers = [
  http.get("/api/app-keys", () => HttpResponse.json({ keys: list() })),

  http.put("/api/app-keys/:name", async ({ params, request }) => {
    const name = String(params.name);
    const nameError = appKeyNameError(name);
    if (nameError) return HttpResponse.json({ error: nameError }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as { label?: unknown; value?: unknown };
    if (typeof body.value !== "string" || body.value.length === 0) {
      return HttpResponse.json({ error: "Value is required." }, { status: 400 });
    }
    if (body.value.length > APP_KEY_MAX_VALUE_LENGTH) {
      return HttpResponse.json(
        { error: `Value must be at most ${APP_KEY_MAX_VALUE_LENGTH} characters.` },
        { status: 400 },
      );
    }
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : name;
    store.set(name, { label, updatedAt: new Date().toISOString() });
    return HttpResponse.json({ ok: true, overridden: false });
  }),

  http.delete("/api/app-keys/:name", ({ params }) => {
    const name = String(params.name);
    if (!store.has(name)) {
      return HttpResponse.json({ error: "Unknown app key." }, { status: 404 });
    }
    store.delete(name);
    return HttpResponse.json({ ok: true });
  }),
];
