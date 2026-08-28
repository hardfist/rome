// The `Messages` stores the People surface reads, and the order they claim an
// account in.
//
// The same stores and the same order as `personTimelineSources` next door,
// stated once here so a row's preview and the page that row opens onto cannot
// come from two different records of the same conversation.

import type { TimelineEntry } from "@rome/api-types/people";
import { linkedInMessages } from "../channels/linkedin-messages.js";
import { agentMessages } from "../channels/messages-agent.js";
import { sentinelLogMessages } from "../channels/messages-sentinel.js";
import type { MessageAccount, Messages } from "../channels/messages.js";
import { whatsAppMessages } from "../channels/whatsapp-messages.js";
import type { DrizzleDb } from "../db/index.js";

/**
 * Every store a person's history can come from, in the order they claim an
 * account.
 *
 * The order is a precedence, and it is the one thing here that is not
 * plumbing: a channel mirror holds the conversation as the channel has it, so
 * it outranks Rome's own transcript of the same messages, which in turn
 * outranks the sentinel's triage record. An account only the sentinel saw
 * still gets its exchanges — the sentinel is last, not excluded.
 *
 * Why a precedence rather than a merge: the stores overlap rather than
 * partition. One inbound WhatsApp message is a `wa_messages` row, a
 * `rome_agent_messages` row on the channel session, and — when the sentinel
 * triaged it — a `sentinel_log` row as well. Merging all three renders one
 * message three times under three refs, so each account's history comes from
 * exactly one store: the first that holds anything for it.
 */
export function personMessageStores(deps: { db: DrizzleDb }): Messages[] {
  return [
    whatsAppMessages(deps.db),
    linkedInMessages(deps.db),
    agentMessages(deps.db),
    sentinelLogMessages(deps.db),
  ];
}

/**
 * The newest entry each account has, from the store that owns it — one answer
 * per account, in the order the accounts were given, and null for an account
 * no store holds anything for.
 *
 * `latest` answering null is the whole of how a store says it holds an
 * account nothing, so the first non-null answer down the stack is both the
 * owning store and the entry to show. That is the same rule `assignAccounts`
 * applies to the page, which is what makes this preview the head of that page.
 *
 * Every call is raised before any of them is awaited, so a store batches the
 * whole listing into one pass over its rows. Asked one account at a time
 * instead, a stream of a thousand accounts would be a thousand passes over
 * each store.
 */
export async function latestPerAccount(
  stores: readonly Messages[],
  accounts: readonly MessageAccount[],
): Promise<(TimelineEntry | null)[]> {
  const asked = accounts.map((account) => stores.map((store) => store.latest([account])));
  const answered = await Promise.all(asked.map((row) => Promise.all(row)));
  return answered.map((row) => row.find((entry) => entry !== null) ?? null);
}
