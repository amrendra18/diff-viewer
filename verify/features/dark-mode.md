# Dark mode

## Sub-features

1. The app follows the system's light or dark mode while it runs, without a restart or a page reload.
2. The window, the text, and the code colors all switch, and switch back.

## How to get to it (user POV)

1. Open a repository and a file, then switch macOS between light and dark in System Settings, Appearance.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature dark-mode`.
2. The harness calls `page.emulateMedia({colorScheme: null})`, sets `nativeTheme.themeSource` to light, and opens `src/app.ts` in the newest practice commit.
3. It sets a marker on `window`, switches `themeSource` to dark, and waits for the dark page background `#131917`.
4. It expects the `export` keyword in `#F97583`, the body text in `#DDE6E0`, and the marker still set (no reload). Screen: `dark-mode.png`.
5. It switches back to light and expects the keyword in `#D73A49` again.

## Gotchas

1. Playwright pins `prefers-color-scheme` to light; `emulateMedia({colorScheme: null})` must run before any `themeSource` change.
