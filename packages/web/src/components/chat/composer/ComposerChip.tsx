import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// One pill language for the pre-send chip row (Option A: color encodes *state*,
// not kind). Every chip shares this geometry — height, radius, padding, text
// size — so the row reads as one system. Kind is told apart by the icon and an
// optional muted prefix; only the live `active` chip carries the primary accent.
export type ComposerChipTone = "active" | "neutral";

const TONE: Record<ComposerChipTone, string> = {
  active: "border-primary/30 bg-primary/10 text-primary",
  neutral: "border-border bg-surface text-foreground",
};

export interface ComposerChipProps extends Omit<ComponentPropsWithoutRef<"span">, "prefix"> {
  icon?: ReactNode;
  // Muted role word in front of the value, e.g. "Agent" / "Skill".
  prefix?: ReactNode;
  tone?: ComposerChipTone;
  // Render the value in the mono stack (skill names, ids).
  mono?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}

export const ComposerChip = forwardRef<HTMLSpanElement, ComposerChipProps>(function ComposerChip(
  { icon, prefix, children, tone = "neutral", mono, onRemove, removeLabel, className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-6 max-w-[14rem] shrink-0 items-center gap-2 rounded-8 border px-2 text-badge",
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      <span className={cn("min-w-0 truncate", mono && "font-mono")}>
        {prefix != null && <span className="font-sans opacity-70">{prefix} </span>}
        {children}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          // The visible box stays 20px so the chip's own height does not move.
          // The pointer target reaches past it through `after:-inset-*`, which
          // is how a Selection control clears the floor without growing its
          // row (docs/ui/component-roles.md, and `Switch` in the kit). Raising
          // the chip to a control step instead is the negative example there.
          className="relative -mr-1 ml-1 shrink-0 rounded-full p-1 opacity-60 transition after:absolute after:-inset-1.5 hover:bg-foreground/10 hover:opacity-100"
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      )}
    </span>
  );
});
