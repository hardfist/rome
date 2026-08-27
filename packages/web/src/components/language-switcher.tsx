import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { i18n, t } = useTranslation("common");
  const current: SupportedLanguage = isSupported(i18n.resolvedLanguage ?? "")
    ? (i18n.resolvedLanguage as SupportedLanguage)
    : "en";

  return (
    <div className={`flex shrink-0 items-center gap-2 text-aux text-muted-foreground ${className}`}>
      <Select
        value={current}
        onValueChange={(next) => {
          if (isSupported(next)) {
            void i18n.changeLanguage(next);
          }
        }}
      >
        <SelectTrigger size="sm" aria-label={t("language.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <SelectItem key={lang} value={lang}>
              {LANGUAGE_LABELS[lang]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
