# `@rome-os/app-web-sdk`

The web runtime SDK apps import, plus the `rome` CLI (`bin/rome.js` → `src/cli/`): `dev` and `build` for the app web bundle, and the Rome App Store commands `login`, `whoami`, and `publish` under `src/cli/store/`.

## Styling contract

Color and shadow values vary with theme and mode. The host owns them, and an app inherits them across the shadow boundary. [`packages/web/src/lib/themes.ts`](../web/src/lib/themes.ts) holds the full list.

Everything else is local. The app's own bundle supplies it, through the imports in [`src/runtime/styles.css`](src/runtime/styles.css).

## Traps

**The store commands talk to a service, and the user-facing name is the store.** CLI output, help text, and docs say "Rome App Store", never the name of the service hosting it. Nothing checks this.
