# Collapse the left pane

## Sub-features

1. The sidebar button and Command-B hide the left pane, leaving a narrow rail.
2. The rail names the commit (short hash) and the file shown; hovering it gives the full path and "file n of m".
3. Command-B, the rail, or the sidebar button bring the pane back.
4. The divider between the file list and the Commits tab keeps its dragged position through collapse, expand, and choosing another commit.

## How to get to it (user POV)

1. Open a repository and a commit. Click the sidebar button at the top left of the pane, or press Command-B.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature collapse-pane`.
2. The harness opens the newest practice commit and drags the divider 100 px down; `aria-valuenow` must move off 55.
3. It clicks the sidebar button and expects the workspace collapsed, the pane hidden, the rail shown, the rail text `<short hash>` and `added.ts`, and the rail title "Commit <short hash>, src/added.ts (file 1 of 4). Show sidebar (⌘B)".
4. Command-B must open the pane with the same `aria-valuenow` and `flex-basis`; Command-B again collapses it; a click on the rail opens it.
5. After choosing "Add the format helper", the divider must still hold its dragged position.
