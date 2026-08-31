/**
 * The channels Rome mirrors, built once for every caller that reads all of
 * them. `Channel` (channel.ts) is what one entry is, and a provider joins the
 * address-book fold, the display-name read and a person's history at once by
 * taking an entry here. Vocabulary: docs/concepts/messaging.md.
 */

import type { DrizzleDb } from "../db/index.js";
import type { Accounts } from "./accounts.js";
import type { Channels } from "./channel.js";
import { linkedInMessages } from "./linkedin-messages.js";
import { whatsAppMessages } from "./whatsapp-messages.js";

/**
 * Every channel Rome holds a mirror of, in the order they claim an account.
 *
 * The address books arrive built rather than made here: a channel that folds
 * its whole address book per call serves every caller from one read of it, and
 * two instances of one book is two folds of it.
 *
 * A channel Rome only ever receives on holds no entry. It mirrors neither an
 * address book nor a history, so its entry would carry two null ports and
 * change no answer — what is known about it comes from the addresses already
 * stored against it, and what was said on it from Rome's own transcript. An
 * entry earns its place by filling at least one port.
 */
export function romeChannels(deps: {
  db: DrizzleDb;
  whatsAppAccounts: Accounts;
  linkedInAccounts: Accounts;
}): Channels {
  return [
    { name: "whatsapp", accounts: deps.whatsAppAccounts, messages: whatsAppMessages(deps.db) },
    { name: "linkedin", accounts: deps.linkedInAccounts, messages: linkedInMessages(deps.db) },
  ];
}
