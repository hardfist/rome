// The People surface's contract. This module holds the timeline read — one
// person's history across every account they are linked to.
//
// The entry shape, the ordering and the cursor are the identity union's, and
// they are re-exported rather than restated. The two surfaces page the same
// entries: a stream row's `latest` is the head of the timeline the same row
// opens, and a cursor written against one has to name a position in the other.
// A second definition of either is a page boundary the two ends disagree about.

import { TIMELINE_PAGE_DEFAULT_LIMIT, TIMELINE_PAGE_MAX_LIMIT } from "./identities.js";

export {
  compareTimelineEntries,
  isAfterTimelineCursor,
  latestDynamic,
  parseTimelineCursor,
  timelineCursor,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  type TimelineEntry,
  type TimelinePage,
} from "./identities.js";

/**
 * The page size a `?limit=` value asks for: clamped to
 * {@link TIMELINE_PAGE_MAX_LIMIT}, and the default for anything that does not
 * name a positive count — absent, empty, zero, negative, or not a number.
 *
 * Never zero. A limit of zero answers an empty page with no cursor, which a
 * caller cannot tell from an exhausted timeline, so it would silently truncate
 * the history rather than reporting a bad request.
 */
export function timelinePageLimit(raw: string | number | null | undefined): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), TIMELINE_PAGE_MAX_LIMIT)
    : TIMELINE_PAGE_DEFAULT_LIMIT;
}
