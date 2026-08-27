import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import {
  APP_KEY_MAX_LABEL_LENGTH,
  APP_KEY_MAX_VALUE_LENGTH,
  appKeyNameError,
} from "@rome/api-types/app-keys";

// App keys are guardian-entered secrets injected into process.env for apps to
// read. The read surface never returns values — only names, labels, and
// whether a real environment variable is shadowing the stored value. Replacing
// a value means retyping it; there is no read-back.
export function appKeysRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/app-keys", async (c) => {
    const rows = await deps.appKeysRepo.list();
    return c.json({
      keys: rows.map((row) => ({
        name: row.name,
        label: row.label,
        updatedAt: row.updatedAt.toISOString(),
        overridden: deps.appKeyInjector.isOverridden(row.name),
      })),
    });
  });

  app.put("/app-keys/:name", async (c) => {
    const name = c.req.param("name");
    const nameError = appKeyNameError(name);
    if (nameError) return c.json({ error: nameError }, 400);

    const body = await c.req
      .json<{ label?: unknown; value?: unknown }>()
      .catch(() => ({}) as { label?: unknown; value?: unknown });

    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "Value is required." }, 400);
    }
    if (body.value.length > APP_KEY_MAX_VALUE_LENGTH) {
      return c.json(
        { error: `Value must be at most ${APP_KEY_MAX_VALUE_LENGTH} characters.` },
        400,
      );
    }
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : name;
    if (label.length > APP_KEY_MAX_LABEL_LENGTH) {
      return c.json(
        { error: `Label must be at most ${APP_KEY_MAX_LABEL_LENGTH} characters.` },
        400,
      );
    }

    await deps.appKeysRepo.upsert({ name, label, value: body.value });
    const live = deps.appKeyInjector.apply(name, body.value);
    return c.json({ ok: true, overridden: !live });
  });

  app.delete("/app-keys/:name", async (c) => {
    const name = c.req.param("name");
    const existing = await deps.appKeysRepo.get(name);
    if (!existing) return c.json({ error: "Unknown app key." }, 404);
    await deps.appKeysRepo.delete(name);
    deps.appKeyInjector.remove(name);
    return c.json({ ok: true });
  });

  return app;
}
