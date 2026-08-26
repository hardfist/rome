export type WelcomeLocale = "en" | "zh-CN";

const GUARDIAN_LANGUAGE_BY_CODE: Record<WelcomeLocale, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese",
};

export function welcomeLocaleFromCode(locale: unknown): WelcomeLocale | undefined {
  if (typeof locale !== "string") return undefined;
  if (!Object.hasOwn(GUARDIAN_LANGUAGE_BY_CODE, locale)) return undefined;
  return locale as WelcomeLocale;
}

export function normalizeWelcomeLocale(locale: unknown): WelcomeLocale {
  return welcomeLocaleFromCode(locale) ?? "en";
}

export function guardianLanguageInstruction(locale: WelcomeLocale): string {
  return `Write every guardian-facing field in ${GUARDIAN_LANGUAGE_BY_CODE[locale]}.`;
}
