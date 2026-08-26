import { Hono } from "hono";
import { parseTimelineCursor, timelinePageLimit } from "@rome/api-types/people";
import { STRANGER_PERSON_ID } from "../../constants.js";
import { readPersonTimeline } from "../../people/timeline.js";
import { personTimelineAccounts, personTimelineSources } from "../../people/timeline-sources.js";
import type { ApiDeps } from "../deps.js";

// The People surface's timeline read. What a page of history is, how it is
// ordered and how it resumes are the contract's (@rome/api-types/people);
// which stores it is merged from is `src/people/`. This route is the join
// between a person id and those two, and holds no rule of its own.

export function peopleRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/people/:id/messages", async (c) => {
    const id = c.req.param("id");
    // The stranger sentinel is a row in the persons table rather than a person,
    // and every dismissed identity is mapped onto it. Answering for it would
    // merge the history of everyone the guardian has ever dismissed into one
    // timeline.
    const person = id === STRANGER_PERSON_ID ? null : await deps.personMappingRepo.findById(id);
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const rawCursor = c.req.query("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }

    // A channel this person holds no account on answers an empty page rather
    // than a 400: channels are open — a Rome App brings its own — so there is
    // no set of names to check one against, and "no history there" is the true
    // answer for every name that is not a typo.
    const channel = c.req.query("channel");
    const accounts = (await personTimelineAccounts(deps, person.channelMappings)).filter(
      (account) => !channel || account.channel === channel,
    );

    return c.json(
      await readPersonTimeline(personTimelineSources(deps), accounts, {
        cursor,
        limit: timelinePageLimit(c.req.query("limit")),
      }),
    );
  });

  return app;
}
