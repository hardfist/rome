// A `Messages` store held in memory: the reference the contract suite is
// proved against, and a store any test can state whole. The obligations it
// meets are messages.ts's.

import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";
import type { MessageAccount, MessageRead, Messages } from "./messages.js";

/** One message the store holds, at the address it arrived on. */
export interface HeldMessage {
  channel: string;
  address: string;
  entry: TimelineEntry;
}

/**
 * `Messages` over `held`, scoped by the `(channel, address)` pair — an address
 * on one channel never selects a message another channel stores under the same
 * string.
 *
 * A message is answered once however many of the given accounts name its
 * address, because a read filters the list rather than making a pass per
 * address.
 */
export function memoryMessages(held: readonly HeldMessage[]): Messages {
  const full = (accounts: readonly MessageAccount[]): TimelineEntry[] => {
    const scope = new Set(
      accounts.flatMap((account) =>
        account.addresses.map((address) => addressKey(account.channel, address)),
      ),
    );
    return held
      .filter((message) => scope.has(addressKey(message.channel, message.address)))
      .map((message) => message.entry)
      .sort(compareTimelineEntries);
  };

  return {
    async read(request: MessageRead) {
      const after = request.after ?? null;
      const limit = Math.max(1, Math.floor(request.limit));
      return full(request.accounts)
        .filter((entry) => after === null || isAfterTimelineCursor(entry, after))
        .slice(0, limit);
    },

    async count(accounts) {
      return full(accounts).length;
    },

    async latest(accounts) {
      return full(accounts)[0] ?? null;
    },
  };
}

const addressKey = (channel: string, address: string) => `${channel}\n${address}`;
