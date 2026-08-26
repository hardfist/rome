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
import { REASONING_EFFORT_OPTIONS } from "@/lib/chat-constants";
import type { ReasoningEffort } from "@/lib/chat-types";

export interface ReasoningEffortMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ReasoningEffort;
  onChange: (next: ReasoningEffort) => void;
  disabled: boolean;
}

export function ReasoningEffortMenu({
  open,
  onOpenChange,
  value,
  onChange,
  disabled,
}: ReasoningEffortMenuProps) {
  const { t } = useTranslation("chat");

  const selected =
    REASONING_EFFORT_OPTIONS.find((option) => option.id === value) ?? REASONING_EFFORT_OPTIONS[1];

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          className="touch-target text-muted-foreground"
          aria-label={t("reasoningEffort.label")}
          title={t("reasoningEffort.label")}
        >
          <span>{t(selected.labelKey)}</span>
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="end"
        className="w-44 rounded-12 border-border bg-surface p-2 shadow-10"
      >
        {REASONING_EFFORT_OPTIONS.map((option) => (
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
