import { formatMessage, messagesFor, type WelcomeMessages } from "../../i18n/locales/index.js";

interface WelcomeWebCopy {
  landing: {
    greeting(agentName: string): string;
    kickoff: string;
    start: string;
    opening: string;
    openError: string;
  };
  emailHandshake: {
    confirmed: string;
    settingUp: string;
    unavailable: string;
    continue: string;
    agentAddress: string;
    guardianAddress: string;
    agree: string;
  };
  emailReceipt: {
    inbox: string;
    connected: string;
    sentTo: string;
    sentAfter: string;
    received: string;
    missing: string;
    spamHint: string;
    resend: string;
    continue: string;
  };
  introChoice: {
    importTitle: string;
    importDescription: string;
    answerTitle: string;
    answerDescription: string;
  };
  browserStep: {
    heading: string;
    openBefore: string;
    addBrowser: string;
    openAfter: string;
    signIn: string;
    returnWhenReady: string;
    openHeading: string;
    openDescription: string;
    notSignedIn: string;
    signedIn: string;
    checking: string;
    skip: string;
    skipSummary: string;
  };
  scouts: {
    skippedSummary: string;
    addedSummary(count: number): string;
    addedHeading: string;
    skippedHeading: string;
    addLater: string;
    heading: string;
    description: string;
    adding: string;
    added: string;
    add: string;
    continue: string;
    skip: string;
    error(status: number): string;
    interval(minutes: number): string;
  };
  ideas: {
    heading: string;
    build: string;
    explore: string;
    exploreSummary: string;
  };
  completion: {
    fallbackHeading: string;
    copied: string;
    copyPrompt: string;
    explore: string;
    opening: string;
    openShowcases: string;
    runAgain: string;
  };
}

function formatInterval(
  interval: WelcomeMessages["web"]["scouts"]["interval"],
  minutes: number,
): string {
  if (minutes < 60) return formatMessage(interval.minutes, { minutes });
  if (minutes % 1440 === 0) {
    return minutes === 1440
      ? interval.daily
      : formatMessage(interval.days, { days: minutes / 1440 });
  }
  if (minutes % 60 === 0) return formatMessage(interval.hours, { hours: minutes / 60 });
  return formatMessage(interval.minutes, { minutes });
}

export function getWelcomeCopy(locale: string | undefined): WelcomeWebCopy {
  const copy = messagesFor(locale).web;
  return {
    ...copy,
    landing: {
      ...copy.landing,
      greeting: (agentName) => formatMessage(copy.landing.greeting, { agentName }),
    },
    scouts: {
      ...copy.scouts,
      addedSummary: (count) =>
        formatMessage(copy.scouts.addedSummary[count === 1 ? "one" : "other"], { count }),
      error: (status) => formatMessage(copy.scouts.error, { status }),
      interval: (minutes) => formatInterval(copy.scouts.interval, minutes),
    },
  };
}
