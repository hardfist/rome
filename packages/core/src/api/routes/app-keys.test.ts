import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { AppKeyInjector } from "../../app-keys/injector.js";
import { appKeysRoutes } from "./app-keys.js";

describe("appKeysRoutes", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", appKeysRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
  });

  const put = (name: string, body: unknown) =>
    app.request(`/app-keys/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores a key, injects it, and lists it without the value", async () => {
    const res = await put("MY_DB_PASSWORD", { label: "Shop DB password", value: "hunter2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, overridden: false });

    const list = await app.request("/app-keys");
    expect(list.status).toBe(200);
    const payload = (await list.json()) as {
      keys: Array<{ name: string; label: string; overridden: boolean; updatedAt: string }>;
    };
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0].name).toBe("MY_DB_PASSWORD");
    expect(payload.keys[0].label).toBe("Shop DB password");
    expect(payload.keys[0].overridden).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });

  it("rejects reserved and malformed names", async () => {
    for (const name of ["ROME_PROFILE", "PATH", "lowercase"]) {
      const res = await put(name, { value: "v" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a missing value", async () => {
    const res = await put("MY_KEY", { label: "no value" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Value is required/);
  });

  it("defaults the label to the name", async () => {
    await put("MY_KEY", { value: "v" });
    const payload = (await (await app.request("/app-keys")).json()) as {
      keys: Array<{ label: string }>;
    };
    expect(payload.keys[0].label).toBe("MY_KEY");
  });

  it("reports overridden when the process environment already owns the name", async () => {
    const env: NodeJS.ProcessEnv = { TAKEN_KEY: "from-operator" };
    deps.appKeyInjector = new AppKeyInjector(env);
    app = new Hono().route("/", appKeysRoutes(deps));

    const res = await put("TAKEN_KEY", { value: "from-dashboard" });
    expect(await res.json()).toEqual({ ok: true, overridden: true });
    expect(env.TAKEN_KEY).toBe("from-operator");

    const list = (await (await app.request("/app-keys")).json()) as {
      keys: Array<{ overridden: boolean }>;
    };
    expect(list.keys[0].overridden).toBe(true);
  });

  it("deletes a key and 404s on an unknown one", async () => {
    await put("MY_KEY", { value: "v" });
    const del = await app.request("/app-keys/MY_KEY", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(
      ((await (await app.request("/app-keys")).json()) as { keys: unknown[] }).keys,
    ).toHaveLength(0);

    const missing = await app.request("/app-keys/MY_KEY", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
