import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppRemixStoreIntent } from "@rome/api-types/apps";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Sheet, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogBody, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { AppInstallConfirm } from "@/components/AppInstallConfirm";
import { AppStoreRemixConfirm } from "@/components/AppStoreRemixConfirm";
import { APP_STORE_BROWSE_URL } from "@/lib/app-store-url";
import { APP_REMIX_SKILL, parseRemixRequest, remixSourceDraft } from "@/lib/app-remix";

/** Message the embedded store posts when the user picks "install on this Rome". */
interface InstallRequestMessage {
  type: "rome:install-request";
  listingId: string;
  version: string | null;
}

function isInstallRequest(value: unknown): value is InstallRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg.type === "rome:install-request" && typeof msg.listingId === "string";
}

export interface AppStoreSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful install so the caller can refresh its app list. */
  onInstalled: () => void;
  /** Full URL to embed. Defaults to the store browse root; quick entries pass a
   *  specific listing URL to land directly on an app. */
  src?: string;
}

/**
 * Right slide-in panel embedding the Rome App Store. The store runs in
 * `embed` mode and posts an install request back to us instead of navigating;
 * we surface a native confirm dialog and install via `/api/apps`.
 */
export function AppStoreSheet({ open, onClose, onInstalled, src }: AppStoreSheetProps) {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const iframe = useRef<HTMLIFrameElement>(null);
  const requestActive = useRef(false);
  const [remix, setRemix] = useState<AppRemixStoreIntent | null>(null);
  const [pending, setPending] = useState<{ listingId: string; version: string | null } | null>(
    null,
  );
  useEffect(() => {
    requestActive.current = pending !== null || remix !== null;
  }, [pending, remix]);

  useEffect(() => {
    if (!open) return;
    function onMessage(event: MessageEvent) {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(APP_STORE_BROWSE_URL).origin ||
        requestActive.current
      )
        return;
      const intent = parseRemixRequest(event.data);
      if (intent) {
        requestActive.current = true;
        setRemix(intent);
        return;
      }
      if (!isInstallRequest(event.data)) return;
      requestActive.current = true;
      setPending({ listingId: event.data.listingId, version: event.data.version });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  // Drop any pending confirm when the whole panel closes.
  useEffect(() => {
    if (!open) {
      setPending(null);
      setRemix(null);
    }
  }, [open]);

  const handleInstalled = useCallback(
    (name: string) => {
      toast.success(t("installed.installSuccess", { name }));
      setPending(null);
      onInstalled();
    },
    [onInstalled, t],
  );

  return (
    <>
      <Sheet open={open} onClose={onClose} ariaLabel={t("header.appStore")}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <SheetTitle className="text-title text-foreground">{t("header.appStore")}</SheetTitle>
            <SheetDescription className="sr-only">{t("header.appStore")} panel</SheetDescription>
          </div>
          <IconButton
            size="sm"
            label={t("install.cancel")}
            onClick={onClose}
            icon={<X aria-hidden />}
          />
        </div>

        <iframe
          ref={iframe}
          title={t("header.appStore")}
          src={src ?? APP_STORE_BROWSE_URL}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      </Sheet>

      {/* Sibling of the Sheet (not a child) so the two Radix dialogs don't fight
          over the focus trap — the confirm dialog takes focus while it's open. */}
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        ariaLabel={t("install.title")}
        size="sm"
      >
        <DialogTitle className="sr-only">{t("install.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("install.title")}</DialogDescription>
        <DialogBody>
          {pending ? (
            <AppInstallConfirm
              listingId={pending.listingId}
              requestedVersion={pending.version}
              onInstalled={handleInstalled}
              onCancel={() => setPending(null)}
            />
          ) : null}
        </DialogBody>
      </Dialog>
      <Dialog
        open={remix !== null}
        onClose={() => setRemix(null)}
        ariaLabel={t("remixStore.title")}
        size="sm"
      >
        <DialogDescription className="sr-only">{t("remixStore.description")}</DialogDescription>
        <DialogBody>
          {remix ? (
            <AppStoreRemixConfirm
              inDialog
              intent={remix}
              onCancel={() => setRemix(null)}
              onConfirm={(pin) => {
                setRemix(null);
                onClose();
                navigate("/chat", {
                  state: {
                    skill: APP_REMIX_SKILL,
                    draft: remixSourceDraft(pin, t),
                  },
                });
              }}
            />
          ) : null}
        </DialogBody>
      </Dialog>
    </>
  );
}
