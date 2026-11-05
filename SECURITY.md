# Security

Please report a security problem privately. Do not open a public issue for it.

1. On the repository's GitHub page, open the "Security" tab and choose "Report a vulnerability". Only the maintainer sees the report.
2. Say what you did, what happened, and what you expected. A small repository or file that shows the problem helps most.

## What counts

The app promises three things. A way to break one of them is a security problem.

1. It never writes to a repository it opens, apart from a filter program git runs (see "What the app trusts"), and it runs only the read-only git commands in [AGENTS.md](AGENTS.md) rule 2.
2. It makes no network request.
3. Text from a repository (commit subjects, author names, paths, file contents) is shown as plain text. It can never run code in the page, create page elements, or reach Node.

## What the app trusts

The app trusts a repository's own `.git/config`, as git does. That file can name a filter program for some files (with a `filter=` line in `.gitattributes`). Git runs that program each time the app opens or refreshes a repository and when it reads unstaged changes, just as `git status` would. The app turns off `core.fsmonitor`, another setting that names a program, but it does not turn off filters. A filter program can write into `.git` on its own. For example, git-lfs stores file content in its cache under `.git/lfs/objects`. It does the same when you run `git status`. Such a write is not a security problem in diff-viewer.

A clone never copies `.git/config` from its source. The risk comes from a `.git` folder made by someone else, such as one inside a downloaded archive. Open such a folder only if you trust who made it. A filter program that runs this way is not a security problem in diff-viewer, because `git status` in the same folder runs it too.

## Partial clones

A partial clone (made with `git clone --filter`) leaves some file data on the server until git needs it. The app opens such a repository without fetching: its git calls set GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=none, so git never fetches that data. A commit that touches such a file still lists its files, without line counts, and a rename whose old file was edited shows as a delete and an add. Opening a file whose data is not on disk shows git's error for that file.

## Supported versions

The app has no server and no accounts. Only the latest commit on the main branch gets fixes.
