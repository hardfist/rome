import { createHash } from "node:crypto";
import type { AppstoreSource } from "./lockfile.js";

export const APPSTORE_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

/** Resolves an app-store source to raw gzipped tarball bytes. */
export type BundleFetcher = (source: AppstoreSource) => Promise<Buffer>;

export async function fetchVerifiedStoreBundle(
  appId: string,
  source: AppstoreSource,
  expectedHash: string,
  bundleFetcher: BundleFetcher,
): Promise<Buffer> {
  const bytes = await bundleFetcher(source);
  if (bytes.length === 0) {
    throw new Error(`App-store bundle for "${appId}" is empty (0 bytes)`);
  }
  if (bytes.length > APPSTORE_BUNDLE_MAX_BYTES) {
    throw new Error(
      `App-store bundle for "${appId}" exceeds ${APPSTORE_BUNDLE_MAX_BYTES}-byte cap (got ${bytes.length})`,
    );
  }
  const computed = createHash("sha256").update(bytes).digest("hex");
  if (computed !== expectedHash.toLowerCase()) {
    throw new Error(
      `App-store bundle hash mismatch for "${appId}": ` +
        `expected ${expectedHash.toLowerCase()}, computed ${computed}. ` +
        `Refusing to use bundle bytes that do not match the expected contentHash.`,
    );
  }
  return bytes;
}
