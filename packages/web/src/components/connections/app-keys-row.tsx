import { useQuery } from "@tanstack/react-query";
import { ChevronRight, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { APP_KEYS_QUERY_KEY, fetchAppKeys } from "@/lib/app-keys-api";
import { cn } from "@/lib/utils";

/**
 * The app-keys entry in the Connections list: same row anatomy as a service
 * card (badge + label left, muted status text right), but it navigates to
 * `/settings/connections/app-keys` instead of opening a ceremony dialog — the
 * chevron carries that difference. The right side shows the stored-key count
 * rather than the connection status vocabulary, which is reserved for
 * credentials.
 */

/** Square badge for the app-keys vault. Rome-owned surface treatment — same
 * primary-tinted box as the Email and Composio badges in
 * `ConnectionBrandBadge`. */
export function AppKeysBadge({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-8 bg-primary/15 text-primary",
        className,
      )}
      aria-hidden
    >
      <KeyRound className="h-5 w-5" />
    </div>
  );
}

export function AppKeysRow() {
  const { t } = useTranslation("settings");
  const keysQuery = useQuery({ queryKey: APP_KEYS_QUERY_KEY, queryFn: fetchAppKeys });
  const count = keysQuery.data?.length;

  return (
    <Button
      asChild
      variant="outline"
      size="md"
      align="between"
      className="h-auto w-full bg-surface py-3 text-left hover:bg-accent"
    >
      <Link to="/settings/connections/app-keys" aria-label={t("appKeys.openLabel")}>
        <span className="flex min-w-0 items-center gap-3">
          <AppKeysBadge />
          <span className="truncate text-ui text-foreground">{t("appKeys.title")}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
          {count !== undefined &&
            (count === 0 ? t("appKeys.noKeysYet") : t("appKeys.keyCount", { count }))}
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </Link>
    </Button>
  );
}
