# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skipsektestnet/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skipsektestnet/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all
four formats models use: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. It reads every format to one specification, finds the lines an edit
names even when the model drifted their whitespace or indentation (three
matching tiers: exact, trailing whitespace, then both ends), and changes
every file or none — a failed edit changes nothing, and when any edit fails
no file is written at all.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22+ and its standard library alone; nothing is installed. The working
directory is the root of the tree the patch applies to. `PATCH` is the patch
file, or `-` (or absent) to read the patch from standard input.

Options, in any order:

- `--format=NAME` — read the patch as `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects the format.
- `--check` — do everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` — match lines exactly (tier 0 only).
- `--` ends the options.

On success it prints one line per changed path (`A` created, `D` deleted,
`M` modified, `R old -> new` moved) in byte order, then `ok: <n> files`.
On failure it prints one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits` (exit 1); a usage, missing-patch, format or parse
problem prints one `error: ...` line (exit 2).

## Practice checks

The kit's practice set (100 checks with the house reference's expected
outcomes) scores this implementation 1000/1000:

```sh
node check.ts <kit>/program/generator/practice.json
```

`tests/extra-tests.mjs` holds twelve more hand-written checks for cases the
practice set does not show (pure insertion at the top of a file, atomicity
across sections, `--check`, SEARCH/REPLACE path reuse, create-then-modify,
move-then-modify, unsafe paths, V4A moves, files without a final line break):

```sh
node tests/extra-tests.mjs
```

## Files

- `main.ts` — the CLI (SPEC.md is the contract).
- `runner.ts` — the kit's trial runner, kept as it is.
- `check.ts` — runs the practice set against `main.ts`.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0h2zmzc4&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
