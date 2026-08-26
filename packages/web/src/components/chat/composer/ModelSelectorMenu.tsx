import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
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

  // `auto` is a value like any other, so the trigger always has something to
  // name. The label IS the state — nothing has to encode "non-default" on top.
  const selected =
    LARGE_MODEL_OPTIONS.find((option) => option.id === value) ??
    LARGE_MODEL_OPTIONS.find((option) => option.id === DEFAULT_LARGE_MODEL_SELECTION)!;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={t("modelSelector.label")}
          title={t("modelSelector.label")}
          className="touch-target"
        >
          <span className="truncate">{t(selected.labelKey)}</span>
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
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
