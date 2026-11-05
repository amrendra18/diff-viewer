# Bare repository

## Sub-features

1. A bare repository opens with its commits only. Its name is the folder name, such as `practice.git`.
2. Its commits and diffs show the same way as in a normal repository.

## How to get to it (user POV)

1. Open a bare repository folder with "Open repository…" or `scripts/start --open /path/to/repo.git`.

## Driving it with scripts/verify

1. Run `scripts/verify fast --feature bare-repository`.
2. `scripts/fixtures` builds `practice.git`, a bare clone of the practice repository (`git clone --bare --no-local`).
3. The harness opens it and expects the header `practice.git`, the branch `main`, and "Commits 12".
4. It clicks the newest commit and `src/app.ts`, and expects the same change rows as the practice repository.
5. The run-level `repositories unchanged` row covers the bare repository's fingerprint.
