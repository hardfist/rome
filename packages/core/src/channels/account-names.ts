// What every platform calls its accounts, behind one call. `TalkAccounts`
// (accounts.ts) is one channel's account plane; this is the display-name half
// of all of them folded together, so a caller holding a (channel,
// channelUserId) pair — the identity of an account, per
// docs/concepts/identity.md — never learns which mirror answers for which
// channel, nor that some channels have no mirror at all.

import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import type { TalkAccounts } from "./accounts.js";

/**
 * One provider's answer to what it calls an account.
 *
 * Null means the provider holds no name for the account — not that the account
 * is unknown, and never an identifier of its own standing in for a name. The
 * fallback is {@link AccountNames}'s to run, once, for every provider.
 */
export interface ProviderNames {
  displayName(channelUserId: string): Promise<string | null>;
}

/** The names a channel's mirror already holds, as its account plane reports
 *  them. Every addressing the channel resolves is accepted, so which form a
 *  caller happens to hold does not decide whether a name comes back. */
export function mirrorNames(accounts: TalkAccounts): ProviderNames {
  return {
    async displayName(channelUserId: string): Promise<string | null> {
      return named((await accounts.resolve(channelUserId))?.name);
    },
  };
}

/** What senders have called themselves on their own messages, per channel.
 *  Null when nothing a channel delivered carried a name. */
export interface PushNames {
  displayName(channel: string, channelUserId: string): Promise<string | null>;
}

/**
 * A push name resolves to a display name only after the account's own mirror
 * has been asked, so this is the same lookup for a name Rome has no address
 * book for as for one it does. Providers are keyed by channel; a channel with
 * no entry — one Rome only ever sees senders on — falls straight through.
 */
export class AccountNames {
  constructor(
    private readonly providers: Readonly<Record<string, ProviderNames>>,
    private readonly pushNames: PushNames,
  ) {}

  /**
   * What to call this account: the name its platform holds, then the name its
   * sender put on a message, then the identifier itself — never an empty
   * string, so a caller always has something to render.
   *
   * A channel that addresses one account several ways answers its platform's
   * name to every one of them. Neither fallback can: a push name is filed
   * under the addressing its message arrived on, and the last resort only
   * echoes what it was asked. A caller that folds addressings itself asks with
   * the account's own address.
   */
  async displayName(channel: string, channelUserId: string): Promise<string> {
    const fromProvider = await this.providers[channel]?.displayName(channelUserId);
    if (fromProvider != null) return fromProvider;
    return (await this.pushNames.displayName(channel, channelUserId)) ?? channelUserId;
  }

  /**
   * The same answers for a listing, positionally — one name per account, in the
   * order asked.
   *
   * This is the call a directory read wants. A mirror answers `resolve` from a
   * read of the whole address book, so naming a listing one await at a time
   * costs one such read per row; asking together lets the mirrors serve the
   * page from the reads already in flight.
   */
  displayNames(accounts: Array<{ channel: string; channelUserId: string }>): Promise<string[]> {
    return Promise.all(
      accounts.map((account) => this.displayName(account.channel, account.channelUserId)),
    );
  }
}

/**
 * The names the sentinel log recorded, from the newest message each sender put
 * one on.
 *
 * The log is read whole, and reads in flight are shared, so naming a page of
 * accounts is one read rather than one per account. That is not a cache: the
 * window closes the moment the read settles, so a name a message just carried
 * is never held back behind a stale one.
 */
export class SentinelPushNames implements PushNames {
  constructor(private readonly log: SentinelLogRepository) {}

  private reading: Promise<Map<string, string>> | null = null;

  async displayName(channel: string, channelUserId: string): Promise<string | null> {
    return (await this.load()).get(`${channel}\n${channelUserId}`) ?? null;
  }

  private load(): Promise<Map<string, string>> {
    if (this.reading) return this.reading;
    const reading = this.read();
    this.reading = reading;
    const done = () => {
      if (this.reading === reading) this.reading = null;
    };
    reading.then(done, done);
    return reading;
  }

  private async read(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const row of await this.log.listLatestDisplayNames()) {
      const name = named(row.displayName);
      if (name) names.set(`${row.channel}\n${row.channelUserId}`, name);
    }
    return names;
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
    {
      whatsapp: mirrorNames(deps.whatsAppAccounts),
      linkedin: mirrorNames(deps.linkedInAccounts),
    },
    new SentinelPushNames(deps.sentinelLogRepo),
  );
}

/** A name, or null where there is only blank space. A stored empty string is a
 *  provider holding no name, not a name that renders as nothing. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
