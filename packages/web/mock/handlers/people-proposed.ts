import { http, HttpResponse } from "msw";
import { STRANGER_PERSON_ID, protectedPersonReason } from "@rome/api-types/persons";
import {
  channelIdentityId,
  isAfterTimelineCursor,
  isAssignableBondLevel,
  latestDynamic,
  parseTimelineCursor,
  personIdentityId,
  timelineCursor,
  whatsAppDisplayName,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/identities";
import {
  accountPresentation,
  parseAccountStateFilter,
  type AccountDirectory,
  type AccountDirectoryRow,
  type AccountRef,
  type CreatePersonRequest,
  type LinkAccountRequest,
  type LinkConflict,
  type MergeRequest,
  type PeopleList,
  type PersonResource,
  type UpdatePersonRequest,
} from "@rome/api-types/people";
import { buildTimeline, proposedApiStore } from "./people";

/**
 * The proposed /people contract — Person, Account, Link — served over the SAME
 * in-memory store as the legacy handlers in ./people.ts, so a write through
 * either contract is visible to the other and the People page can migrate
 * incrementally. Wire types and route map: `@rome/api-types/people`;
 * vocabulary: docs/concepts/identity.md.
 *
 * No core route serves this surface yet. Like /api/identities before it, the
 * contract lives here and in its walkthrough test
 * (src/pages/people/proposed-people-api.test.ts) until the backend lands.
 *
 * The stranger sentinel is implementation, not contract: dismissal is stored
 * as a link to the sentinel row, presented as `state: "dismissed"` through
 * `accountPresentation`, and no /api/people route addresses the sentinel.
 */

const { persons, sentinelSenders, whatsappContacts, ownerOf, nextPersonId, summarize } =
  proposedApiStore;

type PersonFixture = (typeof persons)[number];

/** Stand-in for the per-provider account directory seam: what the platform
 *  calls this account, mirror profile first, push name second, raw id last.
 *  Core's implementation owns this chain in one module per provider. */
function accountDisplayName(channel: string, channelUserId: string): string {
  const contact =
    channel === "whatsapp" ? whatsappContacts.find((c) => c.jid === channelUserId) : undefined;
  const sender = sentinelSenders.find(
    (s) => s.channel === channel && s.channelUserId === channelUserId,
  );
  return (contact ? whatsAppDisplayName(contact) : null) ?? sender?.displayName ?? channelUserId;
}

function messageCountFor(channel: string, channelUserId: string): number {
  if (channel === "whatsapp" && whatsappContacts.some((c) => c.jid === channelUserId)) {
    return summarize(channelUserId).messageCount;
  }
  return sentinelSenders
    .filter((s) => s.channel === channel && s.channelUserId === channelUserId)
    .reduce((total, s) => total + (s.reply ? 2 : 1), 0);
}

function personResource(person: PersonFixture): PersonResource {
  const entries = buildTimeline(personIdentityId(person.id)) ?? [];
  return {
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.channelMappings.map((a) => ({
      channel: a.channel,
      channelUserId: a.channelUserId,
      displayName: accountDisplayName(a.channel, a.channelUserId),
    })),
    messageCount: person.channelMappings.reduce(
      (total, a) => total + messageCountFor(a.channel, a.channelUserId),
      0,
    ),
    latest: latestDynamic(entries),
  };
}

function directoryRow(ref: AccountRef): AccountDirectoryRow {
  const owner = ownerOf(ref.channel, ref.channelUserId);
  const entries = buildTimeline(channelIdentityId(ref.channel, ref.channelUserId)) ?? [];
  return {
    channel: ref.channel,
    channelUserId: ref.channelUserId,
    displayName: accountDisplayName(ref.channel, ref.channelUserId),
    ...accountPresentation(owner),
    messageCount: messageCountFor(ref.channel, ref.channelUserId),
    latest: latestDynamic(entries),
  };
}

/** The sentinel is structure: no /api/people route resolves it. */
const findVisiblePerson = (id: string) =>
  id === STRANGER_PERSON_ID ? undefined : persons.find((p) => p.id === id);

const strangerRow = () => persons.find((p) => p.id === STRANGER_PERSON_ID);

const notFound = (what: string) => HttpResponse.json({ error: `Unknown ${what}` }, { status: 404 });

const linkConflict = (ref: AccountRef, owner: { id: string; displayName: string }) =>
  ({
    error: "account is already linked to another person",
    channel: ref.channel,
    channelUserId: ref.channelUserId,
    linkedPersonId: owner.id,
    linkedPersonName: owner.displayName,
  }) satisfies LinkConflict;

/**
 * The link verb, shared by create and POST :id/accounts. Compare-and-swap on
 * the current owner: `transferFrom` must name it exactly for a takeover, and
 * an unlinked or dismissed account links without one — dismissal is
 * bookkeeping, not ownership, so linking silently displaces it.
 */
function link(
  person: PersonFixture,
  ref: AccountRef,
  transferFrom: string | undefined,
): { ok: true } | { status: number; body: Record<string, unknown> } {
  const owner = ownerOf(ref.channel, ref.channelUserId);
  if (owner?.id === person.id) return { ok: true }; // idempotent re-link
  if (owner && owner.id !== STRANGER_PERSON_ID && owner.id !== transferFrom) {
    return { status: 409, body: linkConflict(ref, owner) };
  }
  if (transferFrom && owner?.id !== transferFrom && owner?.id !== STRANGER_PERSON_ID) {
    return {
      status: 409,
      body: {
        error: "transferFrom does not match the account's current owner",
        linkedPersonId: owner && owner.id !== STRANGER_PERSON_ID ? owner.id : null,
      },
    };
  }
  if (owner) {
    owner.channelMappings = owner.channelMappings.filter(
      (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
    );
  }
  person.channelMappings.push({ channel: ref.channel, channelUserId: ref.channelUserId });
  return { ok: true };
}

const refFromParams = (params: Record<string, unknown>): AccountRef => ({
  channel: String(params.channel),
  channelUserId: decodeURIComponent(String(params.channelUserId)),
});

export const proposedPeopleHandlers = [
  // Curated people only — the sentinel's holdings surface on /api/accounts as
  // dismissed rows, never as a person.
  http.get("/api/people", ({ request }) => {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
    const rows = persons
      .filter((p) => p.id !== STRANGER_PERSON_ID)
      .map(personResource)
      .filter(
        (p) =>
          !q ||
          p.displayName.toLowerCase().includes(q) ||
          p.accounts.some((a) => a.displayName.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          (b.latest?.timestamp ?? -1) - (a.latest?.timestamp ?? -1) ||
          a.displayName.localeCompare(b.displayName),
      );
    return HttpResponse.json({ people: rows } satisfies PeopleList);
  }),

  // Every account ever observed — from links, the sentinel log, and channel
  // mirrors — with its derived state. `?state=unlinked` is the discovery queue
  // that replaces /api/persons/unknown and the union's unknown rows.
  http.get("/api/accounts", ({ request }) => {
    const rawState = new URL(request.url).searchParams.get("state");
    const state = parseAccountStateFilter(rawState);
    if (rawState != null && rawState !== "" && state === null) {
      return HttpResponse.json(
        { error: "state must be unlinked, linked, or dismissed" },
        { status: 400 },
      );
    }
    const seen = new Map<string, AccountRef>();
    const add = (channel: string, channelUserId: string) => {
      seen.set(`${channel}\n${channelUserId}`, { channel, channelUserId });
    };
    for (const p of persons) for (const m of p.channelMappings) add(m.channel, m.channelUserId);
    for (const s of sentinelSenders) add(s.channel, s.channelUserId);
    for (const c of whatsappContacts) if (!c.isGroup) add("whatsapp", c.jid);

    const rows = [...seen.values()]
      .map(directoryRow)
      .filter((row) => !state || row.state === state)
      .sort((a, b) => (b.latest?.timestamp ?? -1) - (a.latest?.timestamp ?? -1));
    return HttpResponse.json({ accounts: rows } satisfies AccountDirectory);
  }),

  // Dismiss: deliberately attribute the account to no one the guardian tracks.
  // Refuses over a linked account — unlink is the verb for that. Idempotent.
  http.post("/api/accounts/:channel/:channelUserId/dismiss", ({ params }) => {
    const ref = refFromParams(params);
    const owner = ownerOf(ref.channel, ref.channelUserId);
    if (owner && owner.id !== STRANGER_PERSON_ID) {
      return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    }
    const sentinel = strangerRow();
    if (!sentinel) return notFound("account");
    if (!owner) {
      sentinel.channelMappings.push({ channel: ref.channel, channelUserId: ref.channelUserId });
    }
    return HttpResponse.json(directoryRow(ref));
  }),

  // Restore: dismissed -> unlinked, back into discovery. Idempotent from
  // unlinked. Refuses over a linked account for the same reason dismiss does.
  http.post("/api/accounts/:channel/:channelUserId/restore", ({ params }) => {
    const ref = refFromParams(params);
    const owner = ownerOf(ref.channel, ref.channelUserId);
    if (owner && owner.id !== STRANGER_PERSON_ID) {
      return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    }
    if (owner) {
      owner.channelMappings = owner.channelMappings.filter(
        (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
      );
    }
    return HttpResponse.json(directoryRow(ref));
  }),

  http.post("/api/people", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<CreatePersonRequest>;
    if (!body.displayName) {
      return HttpResponse.json({ error: "displayName is required" }, { status: 400 });
    }
    const bondLevel = body.bondLevel ?? "other";
    if (!isAssignableBondLevel(bondLevel)) {
      return HttpResponse.json(
        { error: "bondLevel must be inner-circle, acquaintance, or other" },
        { status: 400 },
      );
    }
    const accounts = body.accounts ?? [];
    // Atomic create-and-link: refuse the whole request before creating anything
    // if any named account is held by a real person — never a half-made person.
    for (const ref of accounts) {
      const owner = ownerOf(ref.channel, ref.channelUserId);
      if (owner && owner.id !== STRANGER_PERSON_ID) {
        return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
      }
    }
    const created: PersonFixture = {
      id: nextPersonId(body.displayName),
      displayName: body.displayName,
      bondLevel,
      channelMappings: [],
    };
    persons.push(created);
    for (const ref of accounts) link(created, ref, undefined);
    return HttpResponse.json(personResource(created), { status: 201 });
  }),

  http.get("/api/people/:id/messages", ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const search = new URL(request.url).searchParams;
    const channel = search.get("channel");
    const all = (buildTimeline(personIdentityId(person.id)) ?? []).filter(
      (entry) => !channel || entry.source === channel,
    );
    const rawCursor = search.get("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not a timeline cursor" }, { status: 400 });
    }
    const rawLimit = Number(search.get("limit"));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, TIMELINE_PAGE_MAX_LIMIT)
        : TIMELINE_PAGE_DEFAULT_LIMIT;
    const remaining: TimelineEntry[] = cursor
      ? all.filter((entry) => isAfterTimelineCursor(entry, cursor))
      : all;
    const page = remaining.slice(0, limit);
    const oldest = page.at(-1);
    return HttpResponse.json({
      entries: page,
      nextCursor: remaining.length > page.length && oldest ? timelineCursor(oldest) : null,
    } satisfies TimelinePage);
  }),

  http.get("/api/people/:id", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    return HttpResponse.json(personResource(person));
  }),

  http.patch("/api/people/:id", async ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const body = (await request.json().catch(() => ({}))) as Partial<UpdatePersonRequest>;
    if (body.bondLevel !== undefined) {
      if (protectedPersonReason(person)) {
        return HttpResponse.json(
          { error: "the guardian's bond level cannot be changed" },
          { status: 400 },
        );
      }
      if (!isAssignableBondLevel(body.bondLevel)) {
        return HttpResponse.json(
          { error: "bondLevel must be inner-circle, acquaintance, or other" },
          { status: 400 },
        );
      }
      person.bondLevel = body.bondLevel;
    }
    if (body.displayName !== undefined) {
      if (!body.displayName) {
        return HttpResponse.json({ error: "displayName cannot be empty" }, { status: 400 });
      }
      person.displayName = body.displayName;
    }
    return HttpResponse.json(personResource(person));
  }),

  http.post("/api/people/:id/accounts", async ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const body = (await request.json().catch(() => ({}))) as Partial<LinkAccountRequest>;
    if (!body.channel || !body.channelUserId) {
      return HttpResponse.json(
        { error: "channel and channelUserId are required" },
        { status: 400 },
      );
    }
    const result = link(
      person,
      { channel: body.channel, channelUserId: body.channelUserId },
      body.transferFrom,
    );
    if ("status" in result) return HttpResponse.json(result.body, { status: result.status });
    return HttpResponse.json(personResource(person));
  }),

  http.delete("/api/people/:id/accounts/:channel/:channelUserId", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const ref = refFromParams(params);
    const held = person.channelMappings.some(
      (m) => m.channel === ref.channel && m.channelUserId === ref.channelUserId,
    );
    if (!held) {
      return HttpResponse.json({ error: "account is not linked to this person" }, { status: 404 });
    }
    person.channelMappings = person.channelMappings.filter(
      (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
    );
    return HttpResponse.json(personResource(person));
  }),

  // Merge: :id absorbs `from` — every link transfers, then `from` is deleted.
  // First-class rather than N transfers + a delete, for the same reason
  // transfer itself is explicit: history re-attribution should be atomic.
  http.post("/api/people/:id/merge", async ({ params, request }) => {
    const target = findVisiblePerson(String(params.id));
    if (!target) return notFound("person");
    const body = (await request.json().catch(() => ({}))) as Partial<MergeRequest>;
    if (!body.from) return HttpResponse.json({ error: "from is required" }, { status: 400 });
    if (body.from === target.id) {
      return HttpResponse.json(
        { error: "a person cannot be merged into themselves" },
        { status: 400 },
      );
    }
    const source = findVisiblePerson(body.from);
    if (!source) return notFound("person");
    if (protectedPersonReason(source)) {
      return HttpResponse.json({ error: "the guardian cannot be merged away" }, { status: 400 });
    }
    target.channelMappings.push(...source.channelMappings);
    persons.splice(persons.indexOf(source), 1);
    return HttpResponse.json(personResource(target));
  }),
];
