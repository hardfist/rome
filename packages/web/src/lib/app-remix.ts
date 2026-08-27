import {
  AppRemixStoreIntentSchema,
  AppRemixStorePinSchema,
  type AppRemixStoreIntent,
} from "@rome/api-types/apps";
import type { TFunction } from "i18next";
import { z } from "zod";

export const APP_REMIX_SKILL = "coding:app_remix";

export function parseRemixRequest(value: unknown): AppRemixStoreIntent | null {
  const request = z
    .object({
      type: z.literal("rome:remix-request"),
      ...AppRemixStoreIntentSchema.shape,
    })
    .strict()
    .safeParse(value);
  return request.success
    ? { listingId: request.data.listingId, version: request.data.version }
    : null;
}

export function parseRemixSearch(search: URLSearchParams): AppRemixStoreIntent | null {
  if (search.getAll("listingId").length !== 1 || search.getAll("version").length !== 1) return null;
  const intent = AppRemixStoreIntentSchema.safeParse({
    listingId: search.get("listingId"),
    version: search.get("version"),
  });
  return intent.success ? intent.data : null;
}

const RemixListingSchema = z.object({
  available: z.literal(true),
  listing: z.object({
    id: z.string(),
    name: z.string().nullable(),
    state: z.literal("published"),
  }),
  versions: z.array(
    z.object({
      version: z.string(),
      contentHash: z.string(),
      state: z.enum(["live", "revoked"]),
      sourceAvailable: z.boolean().optional(),
    }),
  ),
});

export function resolveRemixListing(intent: AppRemixStoreIntent, value: unknown) {
  const result = RemixListingSchema.safeParse(value);
  if (!result.success || result.data.listing.id !== intent.listingId) return null;
  const version = result.data.versions.find((row) => row.version === intent.version);
  if (!version || version.state !== "live" || version.sourceAvailable !== true) return null;
  const pin = AppRemixStorePinSchema.safeParse({ ...intent, contentHash: version.contentHash });
  return pin.success ? { pin: pin.data, name: result.data.listing.name ?? intent.listingId } : null;
}

export function remixSourceDraft(source: AppRemixStoreIntent, t: TFunction<"apps">): string {
  return t("remixStore.prompt", { app: source.listingId, version: source.version });
}
