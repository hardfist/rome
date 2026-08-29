import { useTranslation } from "react-i18next";
import { useFileBrowserStore } from "./store/context";

export function HistoryPanel() {
  const { t } = useTranslation("files");
  const history = useFileBrowserStore((s) => s.ui.history);
  const loadingHistory = useFileBrowserStore((s) => s.ui.loadingHistory);

  return (
    <section
      aria-label={t("history.heading")}
      className="hidden w-80 flex-shrink-0 overflow-y-auto border-l border-border bg-surface-muted p-4 @min-[1024px]/fb:block"
    >
      <h3 className="mb-3 text-section text-muted-foreground">{t("history.heading")}</h3>
      {loadingHistory ? (
        <p className="text-ui text-subtle-foreground">{t("history.loading")}</p>
      ) : history.length === 0 ? (
        <p className="text-ui text-subtle-foreground">{t("history.empty")}</p>
      ) : (
        <div className="space-y-2">
          {history.map((entry) => (
            <div key={entry.hash} className="rounded-8 border border-border bg-surface p-3">
              <div className="text-ui text-foreground">{entry.message}</div>
              <div className="mt-1 flex items-center gap-2 text-aux text-subtle-foreground">
                <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                {entry.date && (
                  <>
                    <span>·</span>
                    <span>
                      {new Date(entry.date).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function HistoryMobileSheet() {
  const { t } = useTranslation("files");
  const history = useFileBrowserStore((s) => s.ui.history);
  const loadingHistory = useFileBrowserStore((s) => s.ui.loadingHistory);
  const setShowHistory = useFileBrowserStore((s) => s.ui.setShowHistory);

  return (
    <div
      className="fixed inset-0 z-40 @min-[1024px]/fb:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={t("history.dialogLabel")}
    >
      <div
        className="rome-backdrop-fade absolute inset-0 bg-foreground/40"
        onClick={() => setShowHistory(false)}
        aria-hidden="true"
      />
      <div className="rome-sheet-rise absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-16 border-t border-border bg-surface shadow-25">
        <div className="flex shrink-0 justify-center pb-1 pt-2">
          <div className="h-1 w-10 rounded-full bg-border-strong" />
        </div>
        <div className="flex shrink-0 items-center justify-between px-4 pb-3">
          <h3 className="text-section text-muted-foreground">{t("history.heading")}</h3>
          <button
            type="button"
            onClick={() => setShowHistory(false)}
            className="rounded-8 p-2 text-muted-foreground hover:bg-surface-muted hover:text-foreground"
            aria-label={t("history.closeAria")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-[max(var(--rome-safe-area-bottom),1rem)]">
          {loadingHistory ? (
            <p className="text-ui text-subtle-foreground">{t("history.loading")}</p>
          ) : history.length === 0 ? (
            <p className="text-ui text-subtle-foreground">{t("history.empty")}</p>
          ) : (
            <div className="space-y-2">
              {history.map((entry) => (
                <div
                  key={entry.hash}
                  className="rounded-8 border border-border bg-surface-muted p-3"
                >
                  <div className="text-ui text-foreground">{entry.message}</div>
                  <div className="mt-1 flex items-center gap-2 text-aux text-subtle-foreground">
                    <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                    {entry.date && (
                      <>
                        <span>·</span>
                        <span>
                          {new Date(entry.date).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
