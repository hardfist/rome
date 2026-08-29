# View URLs

A **view** is UI whose content a user can return to or share: a page, a tab, a detail pane, a content-bearing panel or sheet, or a collection under a filter, search, or sort. A **control** is UI that composes the next action — a menu, a picker, a confirmation prompt, a transient popover — and is not a view. A step in a flow that cannot render without in-progress input is a control. A setting that changes the arrangement of a view's content without changing the content is a presentation preference, not a distinct view.

## Statements

- Every view has a URL. Opening that URL in a fresh session renders that view.
- Distinct views have distinct URLs. A view has one canonical URL.
- A view renders from its URL and persisted data alone. State that exists only in the running page may enrich a view but never gates its content.
- Navigating between views updates the URL. The browser back button returns to the previous view.
- The state of a collection view — its filter, search, sort, and position — is part of its URL.
- Per-user presentation preferences stay out of the URL.
- A URL that ever named a view keeps rendering that view, directly or by redirect.
- A view inside an app has its URL within the app's own path namespace, under the same statements.
