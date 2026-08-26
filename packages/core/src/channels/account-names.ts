// What every platform calls its accounts, behind one call. `TalkAccounts`
// (accounts.ts) is one channel's account plane; this is the display-name half
// of all of them folded together, so a caller holding a (channel,
// channelUserId) pair — the identity of an account, per
// docs/concepts/identity.md — never learns which mirror answers for which
// channel, nor that some channels have no mirror at all.

import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import type { TalkAccounts } from "./accounts.js";

/**
 * What to call an account, on any channel.
 *
 * A channel joins by implementing the account plane, which is what a channel
 * that mirrors an address book owes anyway. A channel Rome only ever sees
 * senders on implements nothing and falls through to their push names.
 */
export class AccountNames {
  constructor(
    private readonly providers: Readonly<Record<string, Pick<TalkAccounts, "resolve">>>,
    private readonly pushNames: Pick<SentinelLogRepository, "listLatestDisplayNames">,
  ) {}

  /**
   * The name its platform holds, then the name its sender put on a message,
   * then the identifier itself — never an empty string, so a caller always has
   * something to render.
   *
   * A channel that addresses one account several ways answers its platform's
   * name to every one of them. Neither fallback can: a push name is filed under
   * the addressing its message arrived on, and the last resort only echoes what
   * it was asked. A caller that folds addressings itself asks with the
   * account's own address.
   */
  async displayName(channel: string, channelUserId: string): Promise<string> {
    const [name] = await this.displayNames([{ channel, channelUserId }]);
    return name;
  }

  /**
   * The same answers for a listing, positionally — one name per account, in the
   * order asked.
   *
   * This is the call a directory read wants. Every mirror is asked at once, so
   * a channel that answers from a read of its whole address book serves the
   * page from one such read rather than one per row, and the sentinel log is
   * read once, and only where a mirror left a name unanswered.
   */
  async displayNames(accounts: Array<{ channel: string; channelUserId: string }>) {
    const mirrored = await Promise.all(
      accounts.map(
        (account) => this.providers[account.channel]?.resolve(account.channelUserId) ?? null,
      ),
    );
    const names = mirrored.map((account) => named(account?.name));
    if (names.every((name) => name != null)) return names as string[];

    const pushNames = await this.readPushNames();
    return names.map(
      (name, i) => name ?? pushNames.get(key(accounts[i])) ?? accounts[i].channelUserId,
    );
  }

  /** The name each sender last put on a message, by account. */
  private async readPushNames(): Promise<Map<string, string>> {
    const pushNames = new Map<string, string>();
    for (const row of await this.pushNames.listLatestDisplayNames()) {
      const name = named(row.displayName);
      if (name) pushNames.set(key(row), name);
    }
    return pushNames;
  }
}

/** The channels Rome mirrors an address book for. A provider joins the
 *  directory here, and every caller keeps asking the same one question. */
export function createAccountNames(deps: {
  whatsAppAccounts: TalkAccounts;
  linkedInAccounts: TalkAccounts;
  sentinelLogRepo: SentinelLogRepository;
}): AccountNames {
  return new AccountNames(
    { whatsapp: deps.whatsAppAccounts, linkedin: deps.linkedInAccounts },
    deps.sentinelLogRepo,
  );
}

const key = (account: { channel: string; channelUserId: string }) =>
  `${account.channel}\n${account.channelUserId}`;

/** A name, or null where there is only blank space. A stored empty string is a
 *  platform holding no name, not a name that renders as nothing. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
