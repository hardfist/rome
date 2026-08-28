/**
 * Walkthrough of the proposed /people contract (@rome/api-types/people): the
 * state transitions that are easy to get wrong — atomic create-and-link, the
 * link/transfer compare-and-swap, the account state machine
 * (unlinked -> dismissed -> unlinked -> linked), merge, and cross-account
 * timeline paging. Runs the proposed handlers and the legacy handlers against
 * ONE store, so each step also proves a write through the new contract is
 * visible to the old surface — the property incremental migration rides on.
 *
 * The other contract pinned here: the stranger sentinel never crosses the
 * wire. Dismissal reads as `state: "dismissed"` with a null person, and no
 * /api/people route resolves the sentinel id.
 */
// @vitest-environment jsdom
import { afterAll, beforeAll, expect, test } from "vitest";
import { setupServer } from "msw/node";
import { STRANGER_PERSON_ID } from "@rome/api-types/persons";
import { peopleHandlers } from "../../../mock/handlers/people";
import { proposedPeopleHandlers } from "../../../mock/handlers/people-proposed";

const server = setupServer(...proposedPeopleHandlers, ...peopleHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

// jsdom supplies the `location` MSW needs to resolve the handlers' relative
// paths; requests go to that same origin.
const BASE = "http://localhost:3000";
const DEV_JID = "447700900812@s.whatsapp.net"; // Devika, unlinked WhatsApp sender
const JULES_TG = "883104221"; // Jules, unlinked telegram sender
const LI_URL = "https://www.linkedin.com/in/devika-mock/";

// biome-ignore lint/suspicious/noExplicitAny: contract walkthrough reads loosely on purpose
const call = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test("proposed /people contract walkthrough", async () => {
  // Curated list: no sentinel, Ray holds two accounts.
  let r = await call("GET", "/api/people");
  expect(r.status).toBe(200);
  expect(r.body.people.map((p: { id: string }) => p.id)).not.toContain(STRANGER_PERSON_ID);
  const ray = r.body.people.find((p: { id: string }) => p.id === "ray-oster");
  expect(ray.accounts).toHaveLength(2);
  // Counts ride the listing and cover the whole match.
  expect(r.body.counts.all).toBe(r.body.people.length);

  // The sentinel is not addressable as a person.
  r = await call("GET", `/api/people/${STRANGER_PERSON_ID}`);
  expect(r.status).toBe(404);
  r = await call("POST", `/api/people/${STRANGER_PERSON_ID}/accounts`, {
    channel: "telegram",
    channelUserId: JULES_TG,
  });
  expect(r.status).toBe(404);

  // Discovery: unlinked accounts include Devika (whatsapp) and Jules (telegram).
  r = await call("GET", "/api/accounts?state=unlinked");
  const unlinked = r.body.accounts.map((a: { channelUserId: string }) => a.channelUserId);
  expect(unlinked).toContain(DEV_JID);
  expect(unlinked).toContain(JULES_TG);
  // The contacts list carries nothing about what anyone said, and the state
  // counts describe the whole of it.
  expect(r.body.accounts.every((a: object) => !("latest" in a))).toBe(true);
  expect(r.body.counts.unlinked).toBeGreaterThanOrEqual(r.body.accounts.length);
  r = await call("GET", "/api/accounts?state=bogus");
  expect(r.status).toBe(400);

  // The stream is the same accounts, narrowed to the ones something happened
  // on, with the line to preview. A cursor from one names no position in the
  // other, so each read refuses the other's.
  r = await call("GET", "/api/accounts/stream?state=unlinked");
  expect(r.body.accounts.map((a: { channelUserId: string }) => a.channelUserId)).toContain(DEV_JID);
  expect(r.body.accounts.every((a: { latest: unknown }) => a.latest != null)).toBe(true);
  expect(r.body.silentTotal).toBeUndefined();
  const streamPage = await call("GET", "/api/accounts/stream?limit=1");
  expect(
    (await call("GET", `/api/accounts?cursor=${encodeURIComponent(streamPage.body.nextCursor)}`))
      .status,
  ).toBe(400);

  // Atomic create-and-link: promote Devika. One call, person + link together.
  r = await call("POST", "/api/people", {
    displayName: "Devika",
    bondLevel: "acquaintance",
    accounts: [{ channel: "whatsapp", channelUserId: DEV_JID }],
  });
  expect(r.status).toBe(201);
  const devikaId = r.body.id;
  expect(r.body.accounts).toHaveLength(1);

  // ...she leaves discovery, and the LEGACY surface sees the same write.
  r = await call("GET", "/api/accounts?state=unlinked");
  expect(r.body.accounts.map((a: { channelUserId: string }) => a.channelUserId)).not.toContain(
    DEV_JID,
  );
  r = await call("GET", "/api/persons");
  const legacyDevika = r.body.find((p: { id: string }) => p.id === devikaId);
  expect(legacyDevika.channelMappings).toEqual([{ channel: "whatsapp", channelUserId: DEV_JID }]);

  // Link a second account — an unseen LinkedIn identity; linking does not
  // require the account to have been observed first. Re-link is idempotent.
  r = await call("POST", `/api/people/${devikaId}/accounts`, {
    channel: "linkedin",
    channelUserId: LI_URL,
  });
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(2);
  r = await call("POST", `/api/people/${devikaId}/accounts`, {
    channel: "linkedin",
    channelUserId: LI_URL,
  });
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(2);

  // Conflict: claiming a held account without transferFrom names the owner.
  r = await call("POST", "/api/people/ray-oster/accounts", {
    channel: "whatsapp",
    channelUserId: DEV_JID,
  });
  expect(r.status).toBe(409);
  expect(r.body.linkedPersonId).toBe(devikaId);
  expect(r.body.linkedPersonName).toBe("Devika");

  // Transfer: compare-and-swap on the current owner.
  r = await call("POST", "/api/people/ray-oster/accounts", {
    channel: "whatsapp",
    channelUserId: DEV_JID,
    transferFrom: devikaId,
  });
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(3);
  r = await call("POST", `/api/people/${devikaId}/accounts`, {
    channel: "whatsapp",
    channelUserId: DEV_JID,
    transferFrom: "nadia-petrova", // stale owner
  });
  expect(r.status).toBe(409);
  r = await call("POST", `/api/people/${devikaId}/accounts`, {
    channel: "whatsapp",
    channelUserId: DEV_JID,
    transferFrom: "ray-oster",
  });
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(2);

  // Timeline: cross-account, newest first, opaque cursor, no overlap between
  // pages, channel filter reaches an account with no mirrored history.
  r = await call("GET", `/api/people/${devikaId}/messages?limit=1`);
  expect(r.status).toBe(200);
  expect(r.body.entries).toHaveLength(1);
  expect(r.body.nextCursor).toBeTruthy();
  const firstRef = r.body.entries[0].ref;
  r = await call(
    "GET",
    `/api/people/${devikaId}/messages?limit=10&cursor=${encodeURIComponent(r.body.nextCursor)}`,
  );
  expect(r.body.entries.map((e: { ref: string }) => e.ref)).not.toContain(firstRef);
  r = await call("GET", `/api/people/${devikaId}/messages?channel=linkedin`);
  expect(r.body.entries).toHaveLength(0);

  // Unlink destroys the link; the account itself persists.
  r = await call(
    "DELETE",
    `/api/people/${devikaId}/accounts/linkedin/${encodeURIComponent(LI_URL)}`,
  );
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(1);

  // The account state machine, sentinel never on the wire:
  // unlinked -> dismissed. The response carries the state, not the sentinel.
  r = await call("POST", `/api/accounts/telegram/${JULES_TG}/dismiss`);
  expect(r.status).toBe(200);
  expect(r.body.state).toBe("dismissed");
  expect(r.body.personId).toBeNull();
  expect(r.body.personName).toBeNull();
  // Dismissed accounts leave discovery, appear under ?state=dismissed, and the
  // legacy store shows the same fact as a sentinel mapping (one store).
  r = await call("GET", "/api/accounts?state=unlinked");
  expect(r.body.accounts.map((a: { channelUserId: string }) => a.channelUserId)).not.toContain(
    JULES_TG,
  );
  r = await call("GET", "/api/accounts?state=dismissed");
  expect(r.body.accounts.map((a: { channelUserId: string }) => a.channelUserId)).toContain(
    JULES_TG,
  );
  r = await call("GET", "/api/persons");
  const legacySentinel = r.body.find((p: { id: string }) => p.id === STRANGER_PERSON_ID);
  expect(legacySentinel.channelMappings).toContainEqual({
    channel: "telegram",
    channelUserId: JULES_TG,
  });
  // Dismiss is idempotent; dismissing a linked account refuses.
  r = await call("POST", `/api/accounts/telegram/${JULES_TG}/dismiss`);
  expect(r.status).toBe(200);
  r = await call(`POST`, `/api/accounts/whatsapp/${encodeURIComponent(DEV_JID)}/dismiss`);
  expect(r.status).toBe(409);
  // dismissed -> unlinked (restore), idempotent from unlinked.
  r = await call("POST", `/api/accounts/telegram/${JULES_TG}/restore`);
  expect(r.status).toBe(200);
  expect(r.body.state).toBe("unlinked");
  r = await call("POST", `/api/accounts/telegram/${JULES_TG}/restore`);
  expect(r.status).toBe(200);
  // dismissed -> linked: linking silently displaces a dismissal.
  r = await call("POST", `/api/accounts/telegram/${JULES_TG}/dismiss`);
  expect(r.status).toBe(200);
  r = await call("POST", `/api/people/${devikaId}/accounts`, {
    channel: "telegram",
    channelUserId: JULES_TG,
  });
  expect(r.status).toBe(200);
  r = await call(
    "DELETE",
    `/api/people/${devikaId}/accounts/telegram/${encodeURIComponent(JULES_TG)}`,
  );
  expect(r.status).toBe(200);

  // Merge: a duplicate person's links move atomically, the duplicate dies.
  r = await call("POST", "/api/people", {
    displayName: "Dee",
    accounts: [{ channel: "linkedin", channelUserId: LI_URL }],
  });
  const deeId = r.body.id;
  r = await call("POST", `/api/people/${devikaId}/merge`, { from: deeId });
  expect(r.status).toBe(200);
  expect(r.body.accounts).toHaveLength(2);
  r = await call("GET", `/api/people/${deeId}`);
  expect(r.status).toBe(404);

  // Guardrails: the guardian's bond level is fixed; a person's is not.
  r = await call("PATCH", "/api/people/mock-guardian", { bondLevel: "other" });
  expect(r.status).toBe(400);
  r = await call("PATCH", `/api/people/${devikaId}`, { bondLevel: "inner-circle" });
  expect(r.status).toBe(200);
  expect(r.body.bondLevel).toBe("inner-circle");
});
