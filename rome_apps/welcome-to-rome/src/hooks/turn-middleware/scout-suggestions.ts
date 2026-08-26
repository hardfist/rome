import { messagesFor } from "../../i18n/locales/index.js";
import type { WelcomeLocale } from "../../locale.js";

export interface ScoutSuggestion {
  title: string;
  prompt: string;
  intervalMinutes: number;
  reason: string;
}

export function scoutSuggestionsFromBasis(
  basis: string,
  locale: WelcomeLocale = "en",
  limit = 3,
): ScoutSuggestion[] {
  const normalized = basis.toLowerCase();
  const { templates, fallbacks } = messagesFor(locale).scouts;
  const chosen = templates
    .filter((template) => template.keywords.some((keyword) => normalized.includes(keyword)))
    .map(({ title, prompt, intervalMinutes, reason }) => ({
      title,
      prompt,
      intervalMinutes,
      reason,
    }));

  const suggestions = [...chosen, ...fallbacks].filter(
    (suggestion, index, all) => all.findIndex((item) => item.title === suggestion.title) === index,
  );
  return suggestions.slice(0, Math.max(0, limit));
}
