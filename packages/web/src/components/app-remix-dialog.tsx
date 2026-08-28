import { GitFork } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { TFunction } from "i18next";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { LISTING_HANDLE_PATTERN, parseListingId } from "@/lib/app-listing-id";
import { RomeInputDialog } from "@/components/rome-input-dialog";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { APP_REMIX_SKILL } from "@/lib/app-remix";

function parseRemixName(value: string): { name: string; appId: string } | null {
  const name = value.trim();
  const parsed = parseListingId(name);
  if (!parsed?.scoped || !/^[a-z]/.test(parsed.handle)) return null;
  const { handle, slug } = parsed;
  const appId = `${handle}-${slug.replaceAll("_", "-")}`;
  if (appId.length > 64) return null;
  return { name, appId };
}

export function canRemixApp(app: InstalledAppCard): boolean {
  return app.origin === "appstore" && app.phase === "installed" && app.includeSource === true;
}

export function appRemixDraft(
  app: InstalledAppCard,
  target: { name: string; appId: string },
  t: TFunction<"apps">,
): string {
  const version = app.source.mode === "appstore" ? app.source.version : app.version;
  return t("installed.remixDialog.prompt", { app: app.id, version, name: target.name });
}

interface AppRemixDialogProps {
  app: InstalledAppCard | null;
  onClose: () => void;
}

export function AppRemixDialog({ app, onClose }: AppRemixDialogProps) {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const { data: identity } = useDashboardIdentity();
  const [error, setError] = useState<string | null>(null);
  const guardianHandle =
    identity?.kind === "guardian" && LISTING_HANDLE_PATTERN.test(identity.userId)
      ? identity.userId
      : null;
  const sourceSlug = app?.id.split("/").at(-1);

  useEffect(() => setError(null), [app]);

  const close = () => {
    setError(null);
    onClose();
  };

  const continueInChat = (value: string) => {
    if (!app) return;
    const target = parseRemixName(value);
    if (!target) {
      setError(t("installed.remixDialog.invalidName"));
      return;
    }
    close();
    navigate("/chat", {
      state: {
        draft: appRemixDraft(app, target, t),
        skill: APP_REMIX_SKILL,
      },
    });
  };

  return (
    <RomeInputDialog
      open={app !== null}
      onCancel={close}
      onConfirm={continueInChat}
      title={t("installed.remixDialog.title", { name: app?.displayName ?? "" })}
      description={t("installed.remixDialog.description", {
        name: app?.displayName ?? "",
        version: app?.version ?? "",
      })}
      inputLabel={t("installed.remixDialog.nameLabel")}
      inputPlaceholder={sourceSlug ? `@username/${sourceSlug}` : undefined}
      initialValue={sourceSlug && guardianHandle ? `@${guardianHandle}/${sourceSlug}` : ""}
      confirmLabel={t("installed.remixDialog.confirm")}
      cancelLabel={t("installed.remixDialog.cancel")}
      error={error}
      icon={<GitFork className="h-4 w-4" aria-hidden />}
    />
  );
}
