// What each person has done, across every account they are linked to: the
// newest thing, and how much there is of it — the two numbers a directory row
// shows without opening the dossier.
//
// Read from the same stores as the page in timeline.ts, claimed in the order
// `assignAccounts` defines and for the reason stated there, through the same
// `Messages` verbs. That is what makes the row and the page one answer: the
// preview is the store's `latest`, which `Messages` binds to the head of the
// history its `read` pages, and the number beside it is that history's `count`.

import {
  compareTimelineEntries,
  latestDynamic,
  type AccountDynamic,
  type TimelineEntry,
} from "@rome/api-types/people";
import type { MessageAccount, Messages } from "../channels/messages.js";
import { assignAccounts } from "./timeline.js";

/** A person's history at a glance. `latest` is null exactly when
 *  `messageCount` is zero — a person nobody has ever written to. */
export interface PersonActivity {
  latest: AccountDynamic | null;
  messageCount: number;
}

/**
 * One activity per group of accounts, in the order the groups were given.
 *
 * Positional, and over every group at once: the stores are read for all of
 * them together, so a listing of curated people costs the same handful of
 * queries as a single person.
 */
export async function readPeopleActivity(
  stores: readonly Messages[],
  accountsByPerson: readonly (readonly MessageAccount[])[],
): Promise<PersonActivity[]> {
  const owner = new Map<MessageAccount, Messages>();
  for (const [store, held] of await assignAccounts(stores, accountsByPerson.flat())) {
    for (const account of held) owner.set(account, store);
  }

  // One summary per person per store, over every account of theirs that store
  // owns — not one per account. A store reads a set of accounts as a single
  // history, so this is the same read the page makes, and a message that two
  // addressings of a person both name is one message in both.
  const summaries = accountsByPerson.flatMap((accounts, person) => {
    const byStore = new Map<Messages, MessageAccount[]>();
    for (const account of accounts) {
      const store = owner.get(account);
      if (store === undefined) continue;
      const held = byStore.get(store);
      if (held) held.push(account);
      else byStore.set(store, [account]);
    }
    return [...byStore].map(([store, held]) => ({ person, store, accounts: held }));
  });

  // Every `count` and every `latest` raised before the first is awaited, so a
  // store that groups the calls of a tick answers the whole listing in one pass
  // rather than two per row.
  const [counts, heads] = await Promise.all([
    Promise.all(summaries.map((summary) => summary.store.count(summary.accounts))),
    Promise.all(summaries.map((summary) => summary.store.latest(summary.accounts))),
  ]);

  const activity = accountsByPerson.map(() => ({ heads: [] as TimelineEntry[], messageCount: 0 }));
  summaries.forEach((summary, index) => {
    const person = activity[summary.person];
    if (!person) return;
    person.messageCount += counts[index] ?? 0;
    const head = heads[index];
    if (head) person.heads.push(head);
  });

  return activity.map((person) => ({
    // Through `latestDynamic`, over the stores' heads in the timeline's own
    // order, so a person whose two accounts last spoke in the same second
    // previews the entry their merged timeline opens on rather than whichever
    // store the fold reached first.
    latest: latestDynamic(person.heads.sort(compareTimelineEntries)),
    messageCount: person.messageCount,
  }));
}
