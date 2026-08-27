import { useTranslation } from "react-i18next";
import { formatWhatsAppPhone } from "@rome/api-types/identities";
import type { LinkConflict } from "@rome/api-types/people";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";

// The second half of a link that another person already holds.
//
// The union page re-pointed an account silently. The contract refuses instead,
// and names the holder in the refusal, so the page can say whose account it is
// about to take and take it only when asked again. A transfer re-attributes the
// account's whole message history, which is why it is never the side effect of
// a retry.

/** The account as the guardian would recognize it, rather than as the channel
 *  addresses it. */
function accountLabel(conflict: LinkConflict): string {
  if (conflict.channel !== "whatsapp") return conflict.channelUserId;
  return formatWhatsAppPhone(conflict.channelUserId) ?? conflict.channelUserId;
}

/**
 * Confirm taking an account from the person who holds it.
 *
 * Rendered only for a conflict that names a holder. One with `linkedPersonId`
 * null says the caller's view of the owner is stale and the account is now held
 * by nobody — there is no person to transfer from, so the caller shows the
 * refusal and lets the guardian try again against a fresh read.
 */
export function TransferConfirm({
  conflict,
  busy,
  onCancel,
  onConfirm,
}: {
  conflict: LinkConflict;
  /** True while the transfer is in flight, so the confirm cannot be fired twice. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("people");
  return (
    <RomeConfirmDialog
      open
      destructive
      title={t("transfer.title")}
      description={t("transfer.description", {
        account: accountLabel(conflict),
        owner: conflict.linkedPersonName ?? "",
      })}
      confirmLabel={t("actions.transfer")}
      cancelLabel={t("actions.cancel")}
      confirmDisabled={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
