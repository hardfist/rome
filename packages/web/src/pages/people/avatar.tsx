import { Avatar as KitAvatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** Initials for an avatar: first and last word's initial, or the first two
 *  letters of a single word. "?" when there is no name to reduce. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The neutral tone every row draws on. A channel is a glyph on this page, so
 *  tinting an avatar by channel would be a second, contradictory color
 *  vocabulary on the same row. */
export const AVATAR_TONE = "bg-surface-muted text-muted-foreground";

/** The guardian's own row — the one avatar that is not neutral, marking the one
 *  row the page's uniform treatment does not apply to. */
export const GUARDIAN_TONE = "bg-foreground text-background";

/**
 * The People page's avatar: initials on a neutral tone, never an image.
 *
 * The kit's `Avatar` with only a fallback child, so the roster inherits the
 * kit's ring and size steps and a tone is the one thing a caller sets. Drawing
 * the circle here instead would be a second answer to what an avatar looks
 * like, free to drift from the kit's the moment either moves.
 */
export function Avatar({
  name,
  tone = AVATAR_TONE,
  size = "default",
}: {
  name: string | null | undefined;
  tone?: string;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <KitAvatar size={size} aria-hidden="true">
      <AvatarFallback className={cn("text-aux", tone)}>{initials(name)}</AvatarFallback>
    </KitAvatar>
  );
}
