# csv-reader-speed-01

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Siezy/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Siezy/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0. `solve.js` exports `run(input)` which returns, for
`{text, header}`, exactly the answer csv-reader returns — `{columns, rows, errors}` under
its broken-row policy (BOM drop, `stray_cr`, `quote_junk`, unterminated quotes re-read as
unquoted, CRLF and lone CRs inside quotes read as LF, rows padded or cut to the first
record's width) — and `main.ts` is the harness driver that answers every case in
`/input/cases.json` into `/output/answers.json`.

It is fast because its field readers scan with tight `charCodeAt` loops straight to the
next special character (comma / LF / CR outside quotes; quote / LF / CR inside), fields
are cut out with `slice()`, and only fields that actually contain stray CRs, doubled
quotes or CRs inside quotes are assembled from parts — the common field costs one scan
and one slice, with no per-field result allocation. The scanning core was proposed by
Hermes, the trio's second implementer, and adopted after it beat the previous
`indexOf`-cursor design in A/B benchmarks (isolated-process medians on the review
machine, ~6–7%; a tie by CPU time on a contended shared VM), with identical output on
every test. On the kit's practice set (6 cases, ~10.2M characters of CSV) it runs
roughly 7–9x faster than the csv-reader baseline in local medians, with answers
byte-identical to the reference on every practice case and on extensive randomized
differential fuzzing against csv-reader itself.

## Run it

```sh
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

Requires Node.js 22.18 or later (standard library only, no dependencies). Without the
environment variables it reads `/input/cases.json` and writes `/output/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=y1qp32ce&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
