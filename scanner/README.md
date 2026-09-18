# scanner

Change detection on federal contract data. M2, built from `M2-DESIGN.md` in the
owner's planning folder.

Once a week it downloads the Government of Canada's contract data, compares it
with last week's, and records what changed: an end date that moved, a value
that changed, a contract that disappeared before its end date, or a watched
supplier winning new work. The app's feed shows those changes to the people
watching.

## What is here

| File | What it does |
|---|---|
| `vendor/` | Copies of the public site's own rules: how a row is read, how amendments collapse, and which supplier names are withheld. **Copied, never edited.** Each file names the site commit it came from |
| `snapshot.py` | Raw rows in, one row per live contract out. Withholds individual suppliers' names here, before anything is stored |
| `diff.py` | Last week's contracts against this week's. Returns the events, and whether the run should be refused |
| `drift.py` | Checks `vendor/` still matches the site. Runs first, and **refuses the scan** if a rule has moved |
| `tests/` | `unittest`, invented data only |

Not here yet: `db.py`, `scan.py` and the weekly workflow. Those are PR D.

## Running it

From this folder:

```
py -m unittest        # the tests; no network, no database
py drift.py           # compares vendor/ against the site's main; needs network
```

`py`, not `python`, on jons-pc.

## Rules this folder keeps

- **It never imports from `app/`.** The two meet at the database.
- **A copied rule is never edited to fix a scanner problem.** When the site
  changes, the copy is re-taken from the site in a pull request. Editing a word
  list here would publish, every week, a name the site withholds. `drift.py`
  exists to make that impossible to do quietly.
- **Nothing it prints names anyone.** Counts only: no supplier name, no
  reference number, no key. This repository is public and so are its logs.
- **The downloaded data is never written to disk, cached or uploaded.** It holds
  the names the site withholds.
- **Dates are compared, never day counts.** The source's days-to-expiry figure is
  frozen at download time, so it changes on every contract every week while
  nothing has happened.
- **Standard library only**, with one exception approved on 17 September 2026:
  `psycopg[binary]==3.3.5`, pinned by hash, for the database writer in PR D.
  Nothing in this folder uses it yet.

Iteration 3 adds tender matching from CanadaBuys. That fetches with GET, never
HEAD, and drops the government contact columns (`contactInfoName`,
`contactInfoEmail`, `contactInfoPhone`) at ingest.
