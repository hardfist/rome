import { describe, expect, it } from "vitest";
import type { AccountActivity } from "./account-activity.js";
import { foldAccounts, type MirrorPlane } from "./account-fold.js";
import type { Account, AccountId } from "./accounts.js";
import type { SentinelSenderActivity } from "../db/repositories/sentinel-log.js";

const account = (id: string, addresses: string[] = [id], name: string | null = null): Account => ({
  id: id as AccountId,
  addresses,
  name,
  identifiers: {},
});

const sender = (
  channel: string,
  channelUserId: string,
  row: Partial<SentinelSenderActivity> = {},
): SentinelSenderActivity => ({
  channel,
  channelUserId,
  displayName: null,
  lastMessage: null,
  lastMessageAt: null,
  messageCount: 1,
  ...row,
});

/**
 * A channel that answers only what the fold is allowed to ask: a listing whose
 * accounts carry their own addressing sets, `resolve` for an address the
 * listing does not carry, and the activity half.
 *
 * It holds no separate address map, so a fold that reaches for one fails here
 * rather than quietly reading a second source of the same answer.
 */
class FakePlane implements MirrorPlane {
  listings = 0;
  readonly resolved: string[] = [];

  constructor(
    private readonly accounts: readonly Account[],
    private readonly options: {
      activity?: Map<string, AccountActivity>;
      /** Addresses the listing does not carry, and the account each names. */
      resolves?: Map<string, Account>;
    } = {},
  ) {}

  async listAccounts(_input: { query?: string; cursor?: string; limit: number }) {
    this.listings++;
    return { accounts: [...this.accounts] };
  }

  async resolve(address: string): Promise<Account | null> {
    this.resolved.push(address);
    return (
      this.options.resolves?.get(address) ??
      this.accounts.find((candidate) => candidate.addresses.includes(address)) ??
      null
    );
  }

  async listActivity(): Promise<Map<AccountId, AccountActivity>> {
    return (this.options.activity ?? new Map()) as Map<AccountId, AccountActivity>;
  }
}

const ada = "12025550100@s.whatsapp.net";
const adaLid = "77770001@lid";
const grace = "12025550111@s.whatsapp.net";

describe("foldAccounts", () => {
  it("takes an account's addressing set from the account itself", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid], "Ada")]);

    const fold = await foldAccounts({ whatsapp }, { senders: [], stored: [] });

    expect(fold.accounts).toEqual([
      {
        channel: "whatsapp",
        channelUserId: ada,
        aliases: [ada, adaLid].sort(),
        name: "Ada",
        latest: null,
        messageCount: 0,
      },
    ]);
    // Both addressings name the one account, whichever one a caller holds.
    expect(fold.canonical("whatsapp", adaLid)).toBe(ada);
    expect(fold.canonical("whatsapp", ada)).toBe(ada);
    expect(fold.mirrorFor("whatsapp", adaLid)?.name).toBe("Ada");
    expect(whatsapp.listings).toBe(1);
  });

  it("leaves an account the channel holds one address for addressing itself", async () => {
    const linkedin = new FakePlane([account("ACoAAAda0001")]);

    const fold = await foldAccounts({ linkedin }, { senders: [], stored: [] });

    expect(fold.accounts[0]?.aliases).toEqual(["ACoAAAda0001"]);
    expect(fold.canonical("linkedin", "ACoAAAda0001")).toBe("ACoAAAda0001");
  });

  it("folds a stored address the listing does not carry through resolve", async () => {
    const member = account("ACoAAAda0001");
    const profileUrl = "https://www.linkedin.com/in/ACoAAAda0001/";
    const linkedin = new FakePlane([member], { resolves: new Map([[profileUrl, member]]) });

    const fold = await foldAccounts(
      { linkedin },
      { senders: [], stored: [{ channel: "linkedin", channelUserId: profileUrl }] },
    );

    expect(linkedin.resolved).toEqual([profileUrl]);
    expect(fold.canonical("linkedin", profileUrl)).toBe("ACoAAAda0001");
    expect(fold.mirrorFor("linkedin", profileUrl)?.channelUserId).toBe("ACoAAAda0001");
    // The stored form stays the caller's: the fold reads it, it does not
    // publish it as an address of the account.
    expect(fold.accounts[0]?.aliases).toEqual(["ACoAAAda0001"]);
  });

  it("keeps the listing's owner for a stored address the listing already carries", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid]), account(grace)], {
      // A channel that answered otherwise must not move an address its own
      // listing already placed.
      resolves: new Map([[adaLid, account(grace)]]),
    });

    const fold = await foldAccounts(
      { whatsapp },
      { senders: [], stored: [{ channel: "whatsapp", channelUserId: adaLid }] },
    );

    expect(fold.canonical("whatsapp", adaLid)).toBe(ada);
  });

  it("files a triage row under the account, whichever address it named", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid], "Ada")], {
      activity: new Map([
        [ada, { lastMessageAt: 100, lastMessagePreview: "from the mirror", messageCount: 3 }],
      ]),
    });

    const fold = await foldAccounts(
      { whatsapp },
      {
        senders: [
          sender("whatsapp", adaLid, { lastMessageAt: 200, lastMessage: "seen by triage" }),
        ],
        stored: [],
      },
    );

    expect(fold.sendersFor("whatsapp", ada)).toHaveLength(1);
    expect(fold.recordFor("whatsapp", adaLid)).toEqual({
      latest: { source: "whatsapp", timestamp: 200, preview: "seen by triage" },
      // The mirror's own count stands: a mirrored message and the triage row
      // that saw it are one message.
      messageCount: 3,
    });
  });

  it("reads each channel once, whatever it is asked afterwards", async () => {
    const whatsapp = new FakePlane([account(ada, [ada, adaLid])]);
    const linkedin = new FakePlane([account("ACoAAAda0001")]);

    const fold = await foldAccounts(
      { whatsapp, linkedin },
      {
        senders: [],
        stored: [
          { channel: "whatsapp", channelUserId: adaLid },
          { channel: "whatsapp", channelUserId: adaLid },
        ],
      },
    );

    expect(fold.accounts).toHaveLength(2);
    expect(whatsapp.listings).toBe(1);
    expect(linkedin.listings).toBe(1);
    // The duplicate stored address is one question, not two.
    expect(whatsapp.resolved).toEqual([adaLid]);
  });
});
