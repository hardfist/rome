import type { AppRemixStoreIntent, AppRemixStorePin } from "@rome/api-types/apps";
import { parseListingId } from "@rome-os/libs/app-listing-id";
import type { TFunction } from "i18next";

export const APP_REMIX_SKILL = "coding:app_remix";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRemixIntent(value: unknown): AppRemixStoreIntent | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.listingId !== "string" ||
    !parseListingId(value.listingId) ||
    typeof value.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)
  ) {
    return null;
  }
  return { listingId: value.listingId, version: value.version };
}

export function parseRemixRequest(value: unknown): AppRemixStoreIntent | null {
  if (!isRecord(value) || value.type !== "rome:remix-request" || Object.keys(value).length !== 3) {
    return null;
  }
  return parseRemixIntent({ listingId: value.listingId, version: value.version });
}

export function parseRemixSearch(search: URLSearchParams): AppRemixStoreIntent | null {
  if (search.getAll("listingId").length !== 1 || search.getAll("version").length !== 1) return null;
  return parseRemixIntent({
    listingId: search.get("listingId"),
    version: search.get("version"),
  });
}

export function resolveRemixListing(
  intent: AppRemixStoreIntent,
  value: unknown,
): { pin: AppRemixStorePin; name: string } | null {
  if (
    !parseRemixIntent(intent) ||
    !isRecord(value) ||
    value.available !== true ||
    !isRecord(value.listing) ||
    value.listing.id !== intent.listingId ||
    value.listing.state !== "published" ||
    (value.listing.name !== null && typeof value.listing.name !== "string") ||
    !Array.isArray(value.versions)
  ) {
    return null;
  }
  const version: unknown = value.versions.find(
    (row: unknown) => isRecord(row) && row.version === intent.version,
  );
  if (
    !isRecord(version) ||
    version.state !== "live" ||
    version.sourceAvailable !== true ||
    typeof version.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(version.contentHash)
  ) {
    return null;
  }
  return {
    pin: { ...intent, contentHash: version.contentHash.toLowerCase() },
    name: value.listing.name ?? intent.listingId,
  };
}

export function remixSourceDraft(source: AppRemixStoreIntent, t: TFunction<"apps">): string {
  return t("remixStore.prompt", { app: source.listingId, version: source.version });
}
