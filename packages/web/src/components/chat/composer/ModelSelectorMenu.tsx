import { useTranslation } from "react-i18next";
import { Check, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_LARGE_MODEL_SELECTION, LARGE_MODEL_OPTIONS } from "@/lib/chat-constants";

export interface ModelSelectorMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}

export function ModelSelectorMenu({
  open,
  onOpenChange,
  value,
  onChange,
  disabled,
}: ModelSelectorMenuProps) {
  const { t } = useTranslation("chat");

  const customSelected = value !== DEFAULT_LARGE_MODEL_SELECTION;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          disabled={disabled}
          aria-label={t("modelSelector.label")}
          title={t("modelSelector.label")}
          // `relative` anchors the dot. Ghost has one appearance, so "this menu
          // holds a non-default value" cannot ride the variant — it is the same
          // dot the impersonation menu uses, so both answer that question the
          // same way.
          className="relative touch-target"
        >
          <Zap aria-hidden />
          {customSelected && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-info" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56 rounded-12 p-2">
        <div className="px-2 pb-2 pt-1">
          <p className="text-aux text-subtle-foreground">{t("modelSelector.label")}</p>
        </div>
        {LARGE_MODEL_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={() => onChange(option.id)}
            className={cn(
              "justify-between rounded-8 px-3 py-2 text-ui",
              value === option.id ? "text-info-fg" : "text-foreground",
            )}
          >
            <span>{t(option.labelKey)}</span>
            {value === option.id && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
