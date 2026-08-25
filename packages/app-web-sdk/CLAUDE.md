# `@rome-os/app-web-sdk`

The web runtime SDK apps import, plus the `rome` CLI (`bin/rome.js` → `src/cli/`): `dev` and `build` for the app web bundle, and the Rome App Store commands `login`, `whoami`, and `publish` under `src/cli/store/`.

## Styling contract

`src/runtime/styles.css` carries Tailwind, `tw-animate-css`, and the `@rome-os/ui` canon into an app's bundle. Those imports are what put the token vocabulary inside the app's shadow root. The host promises one thing beyond them: the theme layer, meaning the color and shadow values that track the live theme and mode. Those reach the app as inherited custom properties, which cross the shadow boundary on their own.

Nothing else crosses as a promise. Inheritance cannot be narrowed, so an app also reaches every other property the dashboard declares on `:root`, including names the dashboard never meant to expose. An app that reads one renders correctly in the dashboard and breaks against any other host. Geometry, typography, and the control scale hold the same value under every theme, so the app carries them in its own bundle. An app that ships no kit stylesheet declares the few constants it uses itself.

The canonical statement is [`@rome-os/ui`'s README](../ui/README.md#styling-contract). The layer rules and the test that enforces them are in [`docs/design-system.md`](../../docs/design-system.md#rules-that-keep-the-two-layers-sound).

## Traps

**An app that loses this sheet still renders correctly in the dashboard.** The dashboard declares the kit's constant names on `:root` as well, so a bundle missing the canon inherits them and looks right. The break shows up only against another host, and no build or test run reports it. Every import in `src/runtime/styles.css` is load-bearing for apps rather than a convenience.

**The store commands talk to a service, and the user-facing name is the store.** CLI output, help text, and docs say "Rome App Store", never the name of the service hosting it. Nothing checks this.
