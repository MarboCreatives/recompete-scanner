# scanner

Iteration 2 starts here. Nothing is built yet.

Python, standard library only, run on a scheduled GitHub Action. It stores a
snapshot of each data refresh, diffs it against the previous one, emits events
(`EXPIRY_MOVED`, `VALUE_CHANGED`, `CONTRACT_GONE`, `NEW_AWARD`, later
`POSSIBLE_RECOMPETE` and `ACAN_POSTED`), and writes them into the app's database
through one authenticated path.

It never imports from `app/`. It fetches CanadaBuys with GET, never HEAD, and
drops the government contact columns (`contactInfoName`, `contactInfoEmail`,
`contactInfoPhone`) at ingest.
