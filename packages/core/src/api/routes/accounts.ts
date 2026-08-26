import { Hono } from "hono";
import {
  accountPageLimit,
  parseAccountCursor,
  parseAccountState,
  sliceAccountDirectory,
} from "@rome/api-types/people";
import { readAccountDirectory } from "../../people/account-directory.js";
import type { ApiDeps } from "../deps.js";

// The account directory: every account Rome has observed, and what the guardian
// has decided about each. What a page is, how it is ordered, how it resumes and
// what its numbers count are the contract's (@rome/api-types/people). Which
// sources the directory is folded from is `src/people/account-directory.ts`.
// This route is the join between a query string and those two, and holds no
// rule of its own.
//
// A read. Placing an account is a write on the person's own route; dismissing
// and restoring one are `./account-decisions.ts`.

export function accountsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/accounts", async (c) => {
    const rawState = c.req.query("state");
    const state = parseAccountState(rawState);
    if (rawState != null && rawState !== "" && state === null) {
      return c.json({ error: "state must name an account state" }, 400);
    }

    const rawCursor = c.req.query("cursor");
    const cursor = parseAccountCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not an account cursor" }, 400);
    }

    return c.json(
      sliceAccountDirectory(await readAccountDirectory(deps), {
        query: c.req.query("q"),
        state,
        cursor,
        limit: accountPageLimit(c.req.query("limit")),
        includeSilent: c.req.query("includeSilent") === "true",
      }),
    );
  });

  return app;
}
