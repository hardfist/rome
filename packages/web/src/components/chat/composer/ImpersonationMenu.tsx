import { useTranslation } from "react-i18next";
import { Check, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { PersonResource } from "@rome/api-types/people";

export interface ImpersonationMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPersonId: string;
  onSelectPersonId: (id: string) => void;
  options: PersonResource[];
  selectedPerson: PersonResource | null;
  selectedPersonLabel: string;
  guardianLabel: string;
}

export function ImpersonationMenu({
  open,
  onOpenChange,
  selectedPersonId,
  onSelectPersonId,
  options,
  selectedPerson,
  selectedPersonLabel,
  guardianLabel,
}: ImpersonationMenuProps) {
  const { t } = useTranslation("chat");

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t("impersonation.buttonLabel")}
          icon={
            <>
              <Users aria-hidden />
              {selectedPerson && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-info" />
              )}
            </>
          }
          className={cn(
            "relative touch-target",
            selectedPerson
              ? "bg-info-bg text-info-fg hover:bg-info-bg"
              : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
          )}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-64 p-0">
        <div className="border-b border-border-subtle px-3 py-2">
          <p className="text-aux text-subtle-foreground">{t("impersonation.menuTitle")}</p>
          <p className="mt-1 text-aux text-muted-foreground">
            {t("impersonation.currentlySpeakingAs", { name: selectedPersonLabel })}
          </p>
        </div>
        <div className="p-2">
          <DropdownMenuItem
            onSelect={() => onSelectPersonId("")}
            className={cn(
              "justify-between rounded-8 px-3 py-2 text-ui",
              !selectedPersonId
                ? "bg-surface-muted text-foreground"
                : "text-foreground focus:bg-surface-muted",
            )}
          >
            <span>{guardianLabel}</span>
            {!selectedPersonId && (
              <span className="text-aux text-muted-foreground">{t("impersonation.default")}</span>
            )}
          </DropdownMenuItem>

          {options.map((person) => (
            <DropdownMenuItem
              key={person.id}
              onSelect={() => onSelectPersonId(person.id)}
              className={cn(
                "mt-1 justify-between rounded-8 px-3 py-2 text-ui",
                selectedPersonId === person.id
                  ? "bg-info-bg text-info-fg focus:bg-info-bg"
                  : "text-foreground focus:bg-surface-muted",
              )}
            >
              <span>{person.displayName}</span>
              <span className="flex items-center gap-2">
                <span className="text-aux capitalize text-subtle-foreground">
                  {person.bondLevel}
                </span>
                {selectedPersonId === person.id && (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
              </span>
            </DropdownMenuItem>
          ))}

          {options.length === 0 && (
            <>
              <DropdownMenuSeparator className="mx-0" />
              <div className="px-3 py-2 text-ui text-subtle-foreground">
                {t("impersonation.noOtherUsers")}
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
