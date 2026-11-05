# Highlighting

## Sub-features

1. Code is colored with the github-light theme in light mode and github-dark in dark mode.
2. Changed words inside a changed line carry a stronger tint than the line: green on the new side, red on the old side.
3. Highlighting covers the whole file version, so a line inside a block comment that opens above the hunk is colored as a comment.
4. A file past the 2 s highlighting deadline shows as plain text. The [hostile-text](hostile-text.md) journey proves it.

## How to get to it (user POV)

1. Open a repository, click a commit, and click a source file such as a `.ts` file.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature highlighting`.
2. The harness opens the `special` fixture, hands the color scheme back to the system (`page.emulateMedia({colorScheme: null})`), sets `nativeTheme.themeSource` to light, opens "Edit the big module", and clicks `src/notes.ts`.
3. Light mode checks: the first row is the bar "Show 7 hidden lines, lines 1 to 7", so the line that opens the comment is outside the hunk. Right line 11 (`* const fresh = "not code";`) has only the comment color `#6A737D`. On right line 17, `export` has the keyword color `#D73A49`. The changed word `20` carries the `--add-word` tint and the old `10` carries `--del-word`; the word tint differs from the line tint.
4. It switches the theme to dark and checks `export` turns `#F97583`, the comment stays `#6A737D`, and the word tint changes to the dark `--add-word`.
5. `summary.json` `observations.highlighting` holds every computed color in both themes. Screens: `highlighting-light.png`, `highlighting-dark.png`.

## Gotchas

1. Playwright pins `prefers-color-scheme` to light. Without `emulateMedia({colorScheme: null})` first, `nativeTheme` changes reach the window but not the page's CSS.
2. The page joins neighbouring tokens of the same color into one span, so the keyword check looks for the span that starts with `export`.
