import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ASSIGNABLE_BOND_LEVELS,
  formatWhatsAppPhone,
  normalizeBondLevel,
  type AssignableBondLevel,
} from "@rome/api-types/identities";
import {
  accountRef,
  personMatchesQuery,
  type DirectoryAccount,
  type LinkConflict,
  type PersonResource,
} from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePeople } from "@/hooks/use-people";
import { ChannelPill } from "./channel-meta";
import { MutationError } from "./triage";
import { levelLabelKey } from "./rows";
import { TransferConfirm } from "./transfer";
import { useAccountSearch } from "./use-roster";
import { usePeopleWrites } from "./use-writes";

// The dossier's management gestures: the bond, the accounts that resolve to
// this person, and absorbing a duplicate. Three verbs of the /people contract
// (`./writes.ts`), each settling the reads rather than editing them.
//
// The pickers offer more than what would succeed. An account another person
// holds is offerable, because taking one back is a gesture the guardian has and
// the contract answers the attempt with a conflict naming the holder — which is
// the whole reason a transfer can be explicit rather than silent.

/** The identifier a picker row is recognized by. */
function handleOf(account: { channel: string; channelUserId: string }): string {
  return account.channel === "whatsapp"
    ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
    : account.channelUserId;
}

/**
 * The bond select, the two pickers, and whatever the last write said.
 *
 * The guardian's bond does not move — the contract refuses it — so their card
 * reads the level rather than offering to change it.
 */
export function PersonManagement({
  person,
  onMerged,
}: {
  person: PersonResource;
  /** Where to go once this person has been absorbed: they no longer exist. */
  onMerged: (survivorId: string) => void;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const level = normalizeBondLevel(person.bondLevel);
  const [picker, setPicker] = useState<"link" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingBond, setSavingBond] = useState(false);

  async function handleBond(next: string) {
    setSavingBond(true);
    setError(null);
    try {
      const result = await writes.setBond(person.id, next as AssignableBondLevel);
      if (!result.ok) setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setSavingBond(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      {level === "guardian" ? (
        <p className="text-aux text-muted-foreground sm:text-right">
          {t("detail.bond")}: {t(levelLabelKey(level))}
        </p>
      ) : (
        <Select value={level} disabled={savingBond} onValueChange={(next) => void handleBond(next)}>
          <SelectTrigger aria-label={t("detail.bond")} className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSIGNABLE_BOND_LEVELS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(levelLabelKey(value))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {level !== "guardian" && (
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setPicker("link")}>
            {t("detail.linkAccount")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setPicker("merge")}>
            {t("actions.mergeInto")}
          </Button>
        </div>
      )}

      <MutationError message={error} />

      {picker === "link" && <LinkAccountPicker person={person} onClose={() => setPicker(null)} />}
      {picker === "merge" && (
        <MergePicker person={person} onClose={() => setPicker(null)} onMerged={onMerged} />
      )}
    </div>
  );
}

/**
 * Pick an account to resolve to this person.
 *
 * The search is the server's, because the directory is a synced address book
 * rather than a curated listing: a filter over whichever page arrived would
 * answer "no such account" for a contact the mirror holds.
 */
function LinkAccountPicker({ person, onClose }: { person: PersonResource; onClose: () => void }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<LinkConflict | null>(null);
  const directory = useAccountSearch(search, { enabled: true });

  const held = new Set(person.accounts.map((account) => accountRef(account)));
  const candidates = (directory.data?.accounts ?? []).filter(
    (account) => !held.has(accountRef(account)),
  );

  async function link(account: DirectoryAccount, transferFrom?: string) {
    // The transfer confirm is disabled while `busy`, and this refuses re-entry
    // besides: a disabled button depends on the render having flushed, and a
    // second transfer would re-attribute the account's history all over again.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await writes.link(person.id, account, transferFrom);
      if (result.ok) {
        setTransfer(null);
        onClose();
        return;
      }
      if ("conflict" in result && result.conflict.linkedPersonId) {
        setTransfer(result.conflict);
        return;
      }
      setTransfer(null);
      setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open onClose={onClose} size="md" ariaLabel={t("detail.linkAccount")}>
        <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
          <DialogTitle>{t("detail.linkAccount")}</DialogTitle>
          <DialogDescription>{t("detail.linkDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
          />
          {candidates.length === 0 ? (
            <p className="py-6 text-center text-aux text-subtle-foreground">
              {directory.isPending ? t("page.loading") : t("page.emptyForSearch")}
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {candidates.map((account) => (
                <li key={accountRef(account)}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void link(account)}
                    className="flex w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left last:border-b-0 hover:bg-surface"
                  >
                    <ChannelPill channel={account.channel} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-foreground">
                        {account.displayName}
                      </span>
                      <span className="block truncate text-aux text-muted-foreground">
                        <span className="font-mono tabular-nums">{handleOf(account)}</span>
                        {/* Whose it is right now, so picking one already held is
                            a decision rather than a surprise. */}
                        {account.personName &&
                          ` · ${t("linkPicker.heldBy", { owner: account.personName })}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <MutationError message={error} />
        </DialogBody>
      </Dialog>
      {transfer && (
        <TransferConfirm
          conflict={transfer}
          busy={busy}
          onCancel={() => setTransfer(null)}
          onConfirm={() => {
            const account = candidates.find(
              (candidate) =>
                candidate.channel === transfer.channel &&
                candidate.channelUserId === transfer.channelUserId,
            );
            if (account) void link(account, transfer.linkedPersonId ?? undefined);
          }}
        />
      )}
    </>
  );
}

/**
 * Pick the person this one is a duplicate of.
 *
 * This person is absorbed into the pick, so the page open when the merge lands
 * is the one that goes away — the caller is handed the survivor to navigate to.
 * The listing is curated and bounded, so the search runs over what it returned.
 */
function MergePicker({
  person,
  onClose,
  onMerged,
}: {
  person: PersonResource;
  onClose: () => void;
  onMerged: (survivorId: string) => void;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const people = usePeople();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      (people.data ?? []).filter(
        (candidate) =>
          candidate.id !== person.id &&
          normalizeBondLevel(candidate.bondLevel) !== "guardian" &&
          personMatchesQuery(candidate, search),
      ),
    [people.data, person.id, search],
  );

  async function merge(into: PersonResource) {
    setBusy(true);
    setError(null);
    try {
      const result = await writes.merge(into.id, person.id);
      if (!result.ok) {
        setError("conflict" in result ? result.conflict.error : result.message);
        return;
      }
      onClose();
      onMerged(into.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} size="md" ariaLabel={t("merge.title")}>
      <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
        <DialogTitle>{t("merge.title")}</DialogTitle>
        <DialogDescription>{t("merge.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("merge.selectLabel")}
          placeholder={t("merge.searchPlaceholder")}
        />
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-aux text-subtle-foreground">
            {t("merge.noCandidates")}
          </p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void merge(candidate)}
                  className="flex w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left last:border-b-0 hover:bg-surface"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-foreground">
                      {candidate.displayName}
                    </span>
                    <span className="block truncate text-aux text-muted-foreground">
                      {t(levelLabelKey(normalizeBondLevel(candidate.bondLevel)))}
                      {candidate.accounts.length > 0 &&
                        ` · ${candidate.accounts.map(handleOf).join(", ")}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <MutationError message={error} />
      </DialogBody>
    </Dialog>
  );
}
