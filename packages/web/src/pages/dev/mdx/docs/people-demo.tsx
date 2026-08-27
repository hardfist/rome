import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Avatar as KitAvatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Live specimens for the People-page design note (people-page.mdx).
//
// These are stand-ins, not the shipping components: they carry the design's
// row shapes and glyph vocabulary against literal fixtures, with no data
// fetching, no i18n and no write path. The note is a design document, so it
// has to render on its own — wiring it to the real page's hooks would make it
// a second copy of the page instead of a description of it.

/* ---------------------------------------------------------------- channels */

// Channels are monochrome glyphs, never colors. Status hues stay reserved for
// status semantics, and a channel a Rome App contributes gets the generic
// glyph rather than an undefined palette slot.

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.25 8.24a8.23 8.23 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.26-8.24Zm-3.1 4.2c-.15 0-.4.06-.6.28-.21.22-.8.78-.8 1.9 0 1.11.82 2.19.93 2.34.12.15 1.6 2.44 3.87 3.42.54.23.96.37 1.29.48.54.17 1.03.15 1.42.09.44-.07 1.34-.55 1.53-1.08.19-.53.19-.98.13-1.08-.06-.09-.21-.15-.44-.26-.22-.12-1.34-.66-1.55-.74-.2-.07-.36-.11-.51.12-.15.22-.58.73-.71.88-.13.15-.26.17-.49.06-.22-.12-.94-.35-1.8-1.11-.66-.6-1.11-1.32-1.24-1.55-.13-.22-.02-.34.1-.46.1-.1.22-.26.33-.4.11-.14.15-.23.22-.38.08-.15.04-.28-.02-.4-.06-.11-.5-1.24-.7-1.7-.18-.44-.37-.38-.51-.39l-.44-.01Z" />
    </svg>
  );
}

function TelegramGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M21.6 4.1 2.9 11.3c-.9.34-.9.9-.16 1.13l4.8 1.5 1.85 5.68c.22.6.4.83.83.83.42 0 .6-.19.83-.42l2.28-2.22 4.74 3.5c.87.48 1.5.23 1.72-.8l3.1-14.6c.31-1.27-.49-1.84-1.29-1.48v-.32ZM7.9 13.6l10.28-6.48c.5-.3.97-.14.59.2l-8.8 7.95-.35 3.7-1.72-5.37Z" />
    </svg>
  );
}

function DiscordGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M19.3 5.36A16.8 16.8 0 0 0 15.1 4l-.2.4a15.7 15.7 0 0 1 3.7 1.2 12.9 12.9 0 0 0-11.2 0A15.6 15.6 0 0 1 11.1 4.4L10.9 4a16.8 16.8 0 0 0-4.2 1.36C4 9.4 3.3 13.35 3.65 17.24A16.9 16.9 0 0 0 8.8 20a12.6 12.6 0 0 0 1.1-1.8 11 11 0 0 1-1.73-.84l.42-.33a12 12 0 0 0 10.82 0l.43.33c-.55.33-1.13.61-1.74.84A12.5 12.5 0 0 0 19.2 20a16.8 16.8 0 0 0 5.15-2.76v-.01c.42-4.5-.7-8.42-2.9-11.87ZM9.4 14.86c-1.02 0-1.86-.94-1.86-2.1 0-1.15.82-2.1 1.86-2.1s1.88.95 1.86 2.1c0 1.16-.82 2.1-1.86 2.1Zm5.2 0c-1.02 0-1.86-.94-1.86-2.1 0-1.15.82-2.1 1.86-2.1s1.87.95 1.85 2.1c0 1.16-.81 2.1-1.85 2.1Z" />
    </svg>
  );
}

function WebchatGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 3.6 9A14 14 0 0 1 12 21a14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z" />
    </svg>
  );
}

function AppGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export type Channel = "whatsapp" | "telegram" | "discord" | "webchat" | "app";

export const CHANNEL_META: Record<Channel, { label: string; Glyph: typeof WhatsAppGlyph }> = {
  whatsapp: { label: "WhatsApp", Glyph: WhatsAppGlyph },
  telegram: { label: "Telegram", Glyph: TelegramGlyph },
  discord: { label: "Discord", Glyph: DiscordGlyph },
  webchat: { label: "Web chat", Glyph: WebchatGlyph },
  app: { label: "Rome App", Glyph: AppGlyph },
};

export function ChannelGlyph({ channel, className }: { channel: Channel; className?: string }) {
  const { Glyph } = CHANNEL_META[channel];
  return <Glyph className={cn("size-4", className)} />;
}

export function ChannelPill({ channel }: { channel: Channel }) {
  const { label, Glyph } = CHANNEL_META[channel];
  // The glyph goes in bare: Badge sizes an `<svg>` that carries no `size-*` of
  // its own, and a size written here would opt out of that rule.
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Glyph />
      {label}
    </Badge>
  );
}

/** Every glyph the page can draw, side by side, at muted foreground. */
export function ChannelGlyphSet() {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-12 border border-border bg-surface p-4">
      {(Object.keys(CHANNEL_META) as Channel[]).map((channel) => (
        <span key={channel} className="flex items-center gap-2 text-aux text-muted-foreground">
          <ChannelGlyph channel={channel} />
          {CHANNEL_META[channel].label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_TONE = "bg-surface-muted text-muted-foreground";
const GUARDIAN_TONE = "bg-foreground text-background";

/**
 * The page's avatar: initials on a neutral tone, never an image. It is the kit's
 * Avatar with only a fallback child, so the roster inherits the kit's ring and
 * size steps and a tone is the one thing a caller sets.
 */
export function Avatar({
  name,
  tone = AVATAR_TONE,
  size = "default",
}: {
  name: string;
  tone?: string;
  size?: "default" | "lg";
}) {
  return (
    <KitAvatar size={size} aria-hidden="true">
      <AvatarFallback className={cn("text-aux", tone)}>{initials(name)}</AvatarFallback>
    </KitAvatar>
  );
}

export type Level = "unknown" | "guardian" | "inner-circle" | "acquaintance" | "other" | "stranger";

const LEVEL_LABEL: Record<Level, string> = {
  unknown: "Unknown",
  guardian: "Guardian",
  "inner-circle": "Inner circle",
  acquaintance: "Acquaintance",
  other: "Other",
  stranger: "Stranger",
};

export type Row = {
  id: string;
  name: string;
  level: Level;
  channel: Channel;
  handle?: string;
  preview?: string;
  ago?: string;
  messageCount?: number;
  neverMessaged?: boolean;
};

/** The one row menu: every level the row is not already at, then merge. */
function RowMenu({ row }: { row: Row }) {
  const targets = (Object.keys(LEVEL_LABEL) as Level[]).filter(
    (level) => level !== row.level && level !== "guardian" && level !== "unknown",
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {targets.map((level) => (
          <DropdownMenuItem key={level} variant={level === "stranger" ? "destructive" : "default"}>
            {LEVEL_LABEL[level]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem>Merge into…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ROW_BASE =
  "grid w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left last:border-b-0";

function Frame({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="overflow-hidden rounded-12 border border-border bg-background">
      {label && (
        <div className="border-b border-border-subtle bg-surface px-3 py-1 text-badge text-subtle-foreground">
          {label}
        </div>
      )}
      <div className="p-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ stream */

const STREAM: Row[] = [
  {
    id: "1",
    name: "Mira Okafor",
    level: "inner-circle",
    channel: "whatsapp",
    preview: "landed, heading to the hotel now",
    ago: "4m ago",
  },
  {
    id: "2",
    name: "Dan Levy",
    level: "acquaintance",
    channel: "telegram",
    preview: "sent over the revised deck",
    ago: "22m ago",
  },
  {
    id: "3",
    name: "+1 415 555 0142",
    level: "unknown",
    channel: "whatsapp",
    preview: "Hi — is this the right number for Rome?",
    ago: "1h ago",
  },
  {
    id: "4",
    name: "build-bot",
    level: "other",
    channel: "app",
    preview: "nightly finished: 1117 passed",
    ago: "3h ago",
  },
  { id: "5", name: "Priya Raman", level: "inner-circle", channel: "discord", ago: "6h ago" },
];

/** One row per identity, newest first, carrying only what routing needs. */
export function StreamDemo() {
  return (
    <Frame label="Latest">
      {STREAM.map((row) => (
        <button
          key={row.id}
          type="button"
          className={cn(ROW_BASE, "grid-cols-[2rem_minmax(0,1fr)_auto] hover:bg-surface")}
        >
          <Avatar name={row.name} />
          <span className="grid min-w-0 gap-1 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.8fr)] sm:items-center sm:gap-3">
            <span className="truncate text-ui text-foreground">{row.name}</span>
            <span className="flex min-w-0 items-center gap-2 text-aux text-muted-foreground">
              <span className="text-subtle-foreground" title={CHANNEL_META[row.channel].label}>
                <ChannelGlyph channel={row.channel} />
              </span>
              {row.preview ? (
                <span className="truncate">{row.preview}</span>
              ) : (
                <span className="truncate text-subtle-foreground italic">No preview</span>
              )}
            </span>
          </span>
          <span className="justify-self-end font-mono text-badge tabular-nums text-subtle-foreground">
            {row.ago}
          </span>
        </button>
      ))}
    </Frame>
  );
}

/* ----------------------------------------------------------------- unknown */

const UNKNOWN: Row[] = [
  {
    id: "u1",
    name: "+1 415 555 0142",
    level: "unknown",
    channel: "whatsapp",
    handle: "+1 415 555 0142",
    messageCount: 3,
    preview: "Hi — is this the right number for Rome?",
    ago: "1h ago",
  },
  {
    id: "u2",
    name: "@quietstorm",
    level: "unknown",
    channel: "telegram",
    handle: "@quietstorm",
    messageCount: 1,
    preview: "hey, saw your talk",
    ago: "2d ago",
  },
  {
    id: "u3",
    name: "+44 7700 900321",
    level: "unknown",
    channel: "whatsapp",
    handle: "+44 7700 900321",
    messageCount: 12,
    preview: "CLAIM YOUR PRIZE NOW",
    ago: "5d ago",
  },
];

/** The Unknown chip's row: dense, because the placement decision runs on the
 *  evidence — which channel, which number, how much they have said. */
export function UnknownDemo() {
  return (
    <Frame label="Unknown">
      {UNKNOWN.map((row) => (
        <div
          key={row.id}
          className={cn(
            ROW_BASE,
            "cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto] hover:bg-surface sm:grid-cols-[2rem_minmax(10rem,1.1fr)_minmax(0,1.6fr)_auto]",
          )}
        >
          <Avatar name={row.name} />
          <span className="min-w-0 text-left">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-ui text-foreground">{row.name}</span>
              <ChannelPill channel={row.channel} />
            </span>
            <span className="block truncate text-aux text-muted-foreground">
              <span className="font-mono tabular-nums">{row.handle}</span>
              {" · "}
              <span className="tabular-nums">{row.messageCount} messages</span>
            </span>
          </span>
          <span className="hidden min-w-0 text-left text-aux text-muted-foreground sm:block">
            <span className="block truncate">{row.preview}</span>
          </span>
          <span className="flex items-center justify-end gap-1">
            <span className="font-mono text-badge tabular-nums text-subtle-foreground">
              {row.ago}
            </span>
            <RowMenu row={row} />
          </span>
        </div>
      ))}
    </Frame>
  );
}

/* --------------------------------------------------------------- directory */

const DIRECTORY: { level: Level; total: number; rows: Row[] }[] = [
  {
    level: "guardian",
    total: 1,
    rows: [{ id: "g", name: "Fan Zhang", level: "guardian", channel: "webchat", handle: "You" }],
  },
  {
    level: "inner-circle",
    total: 2,
    rows: [
      {
        id: "d1",
        name: "Mira Okafor",
        level: "inner-circle",
        channel: "whatsapp",
        handle: "+1 206 555 0113",
      },
      {
        id: "d2",
        name: "Priya Raman",
        level: "inner-circle",
        channel: "discord",
        handle: "@priya",
      },
    ],
  },
  {
    level: "acquaintance",
    total: 2,
    rows: [
      { id: "d3", name: "Dan Levy", level: "acquaintance", channel: "telegram", handle: "@danl" },
      {
        id: "d4",
        name: "Ana Ruiz",
        level: "acquaintance",
        channel: "whatsapp",
        neverMessaged: true,
      },
    ],
  },
];

/** The management view: everyone grouped by bond with live totals, three
 *  columns, no channel badges. Clicking the avatar selects. */
export function DirectoryDemo() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Frame label="Directory">
      {DIRECTORY.map((group) => (
        <div key={group.level} className="mb-2 last:mb-0">
          <div className="flex items-baseline gap-2 px-2 py-1">
            <span className="text-ui text-foreground">{LEVEL_LABEL[group.level]}</span>
            <span className="font-mono text-badge tabular-nums text-subtle-foreground">
              {group.total}
            </span>
          </div>
          {group.rows.map((row) => {
            const fixed = row.level === "guardian";
            const isSelected = selected.includes(row.id);
            return (
              <div
                key={row.id}
                className={cn(
                  ROW_BASE,
                  "grid-cols-[2rem_minmax(0,1fr)_auto]",
                  fixed ? "cursor-default" : "hover:bg-surface",
                  isSelected && "bg-primary/10 hover:bg-primary/15",
                )}
              >
                {fixed ? (
                  <Avatar name={row.name} tone={GUARDIAN_TONE} />
                ) : (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`Select ${row.name}`}
                    onClick={() =>
                      setSelected((prev) =>
                        prev.includes(row.id)
                          ? prev.filter((id) => id !== row.id)
                          : [...prev, row.id],
                      )
                    }
                    className="rounded-full outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Avatar name={row.name} />
                  </button>
                )}
                <span className="min-w-0 text-left">
                  <span className="block truncate text-ui text-foreground">{row.name}</span>
                  <span className="block truncate text-aux text-muted-foreground">
                    {row.neverMessaged ? (
                      <span className="italic">No activity yet</span>
                    ) : (
                      <span className="font-mono tabular-nums">{row.handle}</span>
                    )}
                  </span>
                </span>
                <span className="flex items-center justify-end">
                  {!fixed && <RowMenu row={row} />}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {selected.length > 0 && (
        <div className="mt-2 flex items-center justify-between rounded-8 bg-primary/10 px-3 py-2">
          <span className="text-aux text-foreground">{selected.length} selected</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary">
              Move to…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </span>
        </div>
      )}
    </Frame>
  );
}

/* ----------------------------------------------------------- view switcher */

/** The two one-of-N controls: the kit's radiogroups, not styled buttons. */
export function ViewSwitcherDemo() {
  const [view, setView] = useState("latest");
  const [chip, setChip] = useState("all");
  return (
    <div className="flex flex-col gap-3 rounded-12 border border-border bg-surface p-4">
      <SegmentedControl
        aria-label="People view"
        size="sm"
        value={view}
        onValueChange={setView}
        options={[
          { value: "latest", label: "Latest" },
          { value: "directory", label: "Directory" },
        ]}
      />
      <FilterChipGroup
        aria-label="Filter people"
        value={chip}
        onValueChange={setChip}
        options={[
          { value: "all", label: "All" },
          { value: "unknown", label: "Unknown", count: 6 },
          { value: "inner-circle", label: "Inner circle" },
          { value: "acquaintance", label: "Acquaintance" },
          { value: "other", label: "Other" },
          { value: "stranger", label: "Stranger" },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------ person page */

/** The dossier: identity card with bond select and linked-account pills, the
 *  merged timeline grouped by day, a sticky composer. */
export function PersonPageDemo() {
  return (
    <Frame label="/people/:identityId">
      <div className="flex flex-col gap-4 p-2">
        <div className="flex items-start gap-3">
          <Avatar name="Mira Okafor" size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-title text-foreground">Mira Okafor</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-muted-foreground">
                <CHANNEL_META.whatsapp.Glyph />
                +1 206 555 0113
              </Badge>
              <Badge variant="outline" className="font-mono text-muted-foreground">
                <CHANNEL_META.telegram.Glyph />
                @mira
              </Badge>
              <Button size="sm" variant="ghost">
                Link account…
              </Button>
              <Button size="sm" variant="ghost">
                Merge into…
              </Button>
            </div>
          </div>
          <Select defaultValue="inner-circle">
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["inner-circle", "acquaintance", "other", "stranger"] as Level[]).map((level) => (
                <SelectItem key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <div className="text-center text-badge text-subtle-foreground">Today</div>
          {[
            { from: "Mira", text: "landed, heading to the hotel now", at: "09:14", out: false },
            { from: "You", text: "perfect — dinner at 7?", at: "09:16", out: true },
            { from: "Mira", text: "yes, book it", at: "09:31", out: false },
          ].map((msg) => (
            <div key={msg.at} className="flex gap-2 text-body">
              <span className="w-12 shrink-0 font-mono text-badge tabular-nums text-subtle-foreground">
                {msg.at}
              </span>
              <span className="min-w-0">
                {msg.out && <span className="text-muted-foreground">You: </span>}
                <span className="text-foreground">{msg.text}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
          <input
            readOnly
            placeholder="Message Mira…"
            className="h-9 flex-1 rounded-8 border border-border bg-background px-3 text-ui text-foreground placeholder:text-subtle-foreground"
          />
          <Button size="sm">Send</Button>
        </div>
      </div>
    </Frame>
  );
}
