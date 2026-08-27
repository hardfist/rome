import type { AppKeyDto, AppKeysListResponse } from "@rome/api-types/app-keys";
import { fetchJson } from "@/lib/fetch-json";

export type { AppKeyDto };

export async function fetchAppKeys(): Promise<AppKeyDto[]> {
  const payload = await fetchJson<AppKeysListResponse>("/api/app-keys", {
    fallback: "Failed to load app keys.",
  });
  return Array.isArray(payload.keys) ? payload.keys : [];
}

export async function saveAppKey(input: {
  name: string;
  label: string;
  value: string;
}): Promise<{ overridden: boolean }> {
  return await fetchJson<{ ok: boolean; overridden: boolean }>(
    `/api/app-keys/${encodeURIComponent(input.name)}`,
    {
      method: "PUT",
      json: { label: input.label, value: input.value },
      fallback: "Failed to save app key.",
    },
  );
}

export async function deleteAppKey(name: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/app-keys/${encodeURIComponent(name)}`, {
    method: "DELETE",
    fallback: "Failed to remove app key.",
  });
}
