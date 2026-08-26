import { Hono } from "hono";
import type { Context } from "hono";
import {
  dismissAccount,
  restoreAccount,
  type AccountDecisionOutcome,
  type AccountRef,
} from "../../people/account-decisions.js";
import type { ApiDeps } from "../deps.js";

// The account directory's two writes: dismiss an account, and restore one.
// What either means, when either refuses, and what each answers are
// `src/people/account-decisions.ts`'s and the contract's
// (@rome/api-types/people). This route is the join between a path and those,
// and holds no rule of its own beyond which status each outcome is.
//
// The account is named by a pair in the path, not by a body: it is the
// account's identity rather than an argument of the write, so the same account
// is addressed the same way by every verb, and a retry of a POST is a retry of
// the same decision.

export function accountDecisionRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  const answer = async (
    c: Context,
    decide: (deps: ApiDeps, ref: AccountRef) => Promise<AccountDecisionOutcome>,
  ) => {
    const result = await decide(deps, {
      channel: c.req.param("channel") ?? "",
      channelUserId: c.req.param("channelUserId") ?? "",
    });
    if (result.outcome === "unknown") {
      return c.json({ error: "no account is known at that address" }, 404);
    }
    // A refusal rather than a displacement: the body names the person who holds
    // the account, so the client can offer unlinking them by name.
    if (result.outcome === "conflict") return c.json(result.conflict, 409);
    return c.json(result.decision);
  };

  app.post("/accounts/:channel/:channelUserId/dismiss", (c) => answer(c, dismissAccount));
  app.post("/accounts/:channel/:channelUserId/restore", (c) => answer(c, restoreAccount));

  return app;
}
