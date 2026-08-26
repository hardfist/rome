// User-facing strings for the scripted conversation live in the app's locale
// JSON. This adapter only interpolates runtime values and shapes component props.

import type { AppIdea } from "../../db/repositories/progress.js";
import { formatMessage, messagesFor, type WelcomeMessages } from "../../i18n/locales/index.js";
import type { WelcomeLocale } from "../../locale.js";

/** Props for the `completion-card` inline component. */
export interface CompletionProps {
  heading: string;
  body?: string;
  kickoffPrompt?: string;
}

export interface WelcomeCopy {
  emailIntro(agentName: string): string;
  emailSentLead: string;
  helloEmailSubject: string;
  helloEmailBody(agentName: string): string;
  greet: string;
  magicTrick: string;
  chatgptNoMemory: string;
  chatgptFailed: string;
  questionsLead: string;
  savingMemoryLead: string;
  scoutsLead: string;
  ideasHandoffLead: string;
  ideasFailed: string;
  unexpectedError: string;
  takeaway(summary: string): string;
  pickedIdea(idea: AppIdea): CompletionProps;
  finishedNoPick: CompletionProps;
  alreadyDone: CompletionProps;
}

function serverCopy(locale: WelcomeLocale): WelcomeMessages["server"] {
  return messagesFor(locale).server;
}

export function copyFor(locale: WelcomeLocale): WelcomeCopy {
  const copy = serverCopy(locale);
  return {
    emailIntro: (agentName) => formatMessage(copy.emailIntro, { agentName }),
    emailSentLead: copy.emailSentLead,
    helloEmailSubject: copy.helloEmailSubject,
    helloEmailBody: (agentName) => formatMessage(copy.helloEmailBody, { agentName }),
    greet: copy.greet,
    magicTrick: copy.magicTrick,
    chatgptNoMemory: copy.chatgptNoMemory,
    chatgptFailed: copy.chatgptFailed,
    questionsLead: copy.questionsLead,
    savingMemoryLead: copy.savingMemoryLead,
    scoutsLead: copy.scoutsLead,
    ideasHandoffLead: copy.ideasHandoffLead,
    ideasFailed: copy.ideasFailed,
    unexpectedError: copy.unexpectedError,
    takeaway: (summary) => formatMessage(copy.takeaway, { summary }),
    pickedIdea: (idea) => ({
      heading: formatMessage(copy.pickedIdea.heading, { title: idea.title }),
      body: copy.pickedIdea.body,
      kickoffPrompt: idea.prompt,
    }),
    finishedNoPick: copy.finishedNoPick,
    alreadyDone: copy.alreadyDone,
  };
}
