/**
 * The tone the composer's icon controls share.
 *
 * Three of them carry it — the paperclip, the model menu and the impersonation
 * menu — and only the last two can reach the active state. Keeping the pair in
 * one place is what stops "muted at rest, accented when non-default" from
 * meaning three slightly different things in one row.
 *
 * It reads as a `variant` on `IconButton`, and that is what it should be. The
 * kit has no such prop yet — `docs/ui/component-roles.md` names the gap under
 * Known divergences — so the classes live here until it does.
 */

/** Resting: the control recedes until pointed at. */
export const CONTROL_TONE_REST = "text-muted-foreground hover:text-foreground";

/**
 * Holding a non-default value. `hover:bg-info-bg` restates the resting fill so
 * the accent survives hover, which `IconButton`'s own `hover:bg-surface-hover`
 * would otherwise repaint.
 */
export const CONTROL_TONE_ACTIVE = "bg-info-bg text-info-fg hover:bg-info-bg";
