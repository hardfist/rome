import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AssignableBondLevel } from "@rome/api-types/identities";
import type { DirectoryAccount, PersonResource } from "@rome/api-types/people";
import { ACCOUNTS_KEY, PEOPLE_KEY, TIMELINE_KEY } from "./use-roster";
import {
  createPerson,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
  updatePerson,
  type AccountRef,
  type WriteOutcome,
} from "./writes";

// Every write the People page makes, and how one settles.
//
// A write settles by invalidation, never by patching what is cached. The page
// renders the server's rows and the server's counts, and a client that edited
// either would be rendering its own guess of what the write did — which is
// exactly the guess the contract's consolidation exists to remove, since one
// gesture can move several addresses at once and re-derive a count the reader
// then sees disagree with the next refetch.
//
// A verb resolves once that refetch has landed, not when the write returned. A
// gesture that reports itself done at the response leaves the row it acted on
// standing for as long as the read takes, which reads as a write that did
// nothing.
//
// One method per gesture the page has, which is fewer than the contract's verbs:
// unlink is `./writes.ts`'s and stays there until a gesture asks for it. This
// module is policy about settling, and there is nothing to settle for a write
// nobody makes.

export interface PeopleWrites {
  /** Create a person for an account nobody has placed, in one request. */
  place(
    account: AccountRef,
    person: { displayName: string; bondLevel: AssignableBondLevel },
  ): Promise<WriteOutcome<PersonResource>>;
  /** Link an account onto a person. `transferFrom` names the person it is taken
   *  from, which the contract requires when somebody else holds it. */
  link(
    personId: string,
    account: AccountRef,
    transferFrom?: string,
  ): Promise<WriteOutcome<PersonResource>>;
  dismiss(account: AccountRef): Promise<WriteOutcome<DirectoryAccount>>;
  restore(account: AccountRef): Promise<WriteOutcome<DirectoryAccount>>;
  /** `into` absorbs `from`, and `from` is gone. */
  merge(into: string, from: string): Promise<WriteOutcome<PersonResource>>;
  setBond(personId: string, bondLevel: AssignableBondLevel): Promise<WriteOutcome<PersonResource>>;
}

export function usePeopleWrites(): PeopleWrites {
  const { t } = useTranslation("people");
  const queryClient = useQueryClient();

  // By prefix, so one call covers the roster's people query, the dossier's
  // single-person read, the composer's shared mention cache and every cached
  // chip, term and page of the directory. The three roots are the whole of what
  // a people write can have changed.
  const settle = useCallback(
    () =>
      Promise.all(
        [PEOPLE_KEY, ACCOUNTS_KEY, TIMELINE_KEY].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
    [queryClient],
  );

  return useMemo(() => {
    const settling = async <T>(write: () => Promise<WriteOutcome<T>>) => {
      const outcome = await write();
      if (outcome.ok) await settle();
      return outcome;
    };

    // Callers hand over whatever row they are holding — a directory account, a
    // person's linked account — so the pair is projected here rather than
    // spread, and a request never carries a field the verb has no place for.
    const ref = (account: AccountRef): AccountRef => ({
      channel: account.channel,
      channelUserId: account.channelUserId,
    });

    return {
      place: (account, person) =>
        settling(() => createPerson({ ...person, accounts: [ref(account)] }, t)),
      link: (personId, account, transferFrom) =>
        settling(() =>
          linkAccount(personId, { ...ref(account), ...(transferFrom ? { transferFrom } : {}) }, t),
        ),
      dismiss: (account) => settling(() => dismissAccount(ref(account), t)),
      restore: (account) => settling(() => restoreAccount(ref(account), t)),
      merge: (into, from) => settling(() => mergePeople(into, from, t)),
      setBond: (personId, bondLevel) => settling(() => updatePerson(personId, { bondLevel }, t)),
    };
  }, [settle, t]);
}
