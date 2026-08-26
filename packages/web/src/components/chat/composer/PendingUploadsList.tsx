import { useTranslation } from "react-i18next";
import type { PendingUpload } from "@/lib/chat-types";
import { ComposerChip } from "./ComposerChip";

export interface PendingUploadsListProps {
  uploads: PendingUpload[];
  onRemove: (id: string) => void;
  disabled: boolean;
}

/**
 * Pending attachments, rendered in the same chip language as the pre-send tray.
 * They share a surface, so a second pill geometry here read as two systems —
 * `ComposerChip` owns height, radius, padding and text size for both.
 */
export function PendingUploadsList({ uploads, onRemove, disabled }: PendingUploadsListProps) {
  const { t } = useTranslation("chat");
  if (uploads.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {uploads.map((upload, index) => (
        <ComposerChip
          key={upload.id}
          prefix={t("composer.filePill", { index: index + 1 })}
          title={upload.file.name}
          onRemove={disabled ? undefined : () => onRemove(upload.id)}
          removeLabel={t("composer.removeFile", { name: upload.file.name })}
        >
          {upload.file.name}
        </ComposerChip>
      ))}
    </div>
  );
}
