/** Initials for an avatar: first and last word's initial, or the first two
 *  letters of a single word. "?" when there is no name to reduce. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  tone,
  size = "md",
}: {
  name: string | null | undefined;
  tone: string;
  size?: "sm" | "md";
}) {
  const sizes = {
    sm: "h-8 w-8 text-aux",
    md: "h-10 w-10 text-aux",
  };
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full ${sizes[size]} ${tone}`}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
