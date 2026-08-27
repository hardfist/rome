import type { TFunction } from "i18next";

// Time rendering shared by the stream and the person timeline. Both read epoch
// seconds — the unit every People-page surface carries — and both answer in the
// active locale.

/** A stream row's age: coarse on purpose, since the stream is ordered and the
 *  label only has to say "how fresh". */
export function timeAgo(t: TFunction<"people">, ts: number | null): string {
  if (!ts) return "";
  const diffSec = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diffSec < 60) return t("timeAgo.justNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("timeAgo.minutes", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("timeAgo.hours", { count: diffHr });
  return t("timeAgo.days", { count: Math.floor(diffHr / 24) });
}

/** Local midnight, in epoch seconds, of the day a timestamp falls on — the key
 *  the timeline groups by, so a day boundary is a calendar comparison rather
 *  than an elapsed-time one. */
export function startOfDay(ts: number): number {
  const date = new Date(ts * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function dayLabel(t: TFunction<"people">, dayStart: number, locale: string): string {
  const today = startOfDay(Math.floor(Date.now() / 1000));
  if (dayStart === today) return t("timeline.today");
  // Yesterday is a calendar step, not 24 hours: the day either side of a DST
  // change is 23 or 25 hours long, and subtracting a fixed day would label
  // yesterday's entries with a date.
  const previous = new Date(today * 1000);
  previous.setDate(previous.getDate() - 1);
  if (dayStart === startOfDay(Math.floor(previous.getTime() / 1000))) {
    return t("timeline.yesterday");
  }
  // The year appears only once it disambiguates. Inside this year "Mar 5" is
  // the shorter, more readable label; past it, "Mar 5" names a day in any of
  // several years — and a timeline that pages backwards reaches those.
  const day = new Date(dayStart * 1000);
  const thisYear = day.getFullYear() === new Date(today * 1000).getFullYear();
  return day.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

export function clockTime(ts: number, locale: string): string {
  return new Date(ts * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** The locale the date and clock helpers render in. Read from the browser
 *  rather than i18next: which calendar and clock a reader expects is a platform
 *  setting, not the language the surrounding copy happens to be in. */
export function navigatorLocale(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}
