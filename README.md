# Recompete Scanner

Watchlist and alert product for Canadian federal contracts. Companion to
[recompeteradar.ca](https://recompeteradar.ca), which is a separate repository
and is not modified from here.

A supplier follows contracts and competitors; this product tells them when
something changes: an expiry date moves, a value changes, a contract disappears,
a watched vendor wins new work, or an open tender looks like the recompete for a
watched contract.

## Layout

| Folder | What | Runs on |
|---|---|---|
| `app/` | Next.js web app: magic-link accounts, watchlists, event feed, digest email | Vercel, deploys on push |
| `scanner/` | Python (standard library only) that diffs data refreshes and matches open tenders | Scheduled GitHub Action |

The two folders never import from each other. They meet at the Postgres
database (Neon) and one authenticated write path.

## Rules that are not negotiable

1. No passwords anywhere. Magic-link sign in only.
2. Individual vendor names are withheld at the display path, and the
   suppressed-names list is never written to a file, log or artifact.
3. `buyer_name` is never stored or shown.
4. A fuzzy tender match is always labelled a possible match, never a fact.
5. Every expiry date carries the option-year caveat.
6. No email address, user id or watchlist in logs, error reports or analytics.
7. No payment is taken and no price is published. The paid boundary exists in
   code and is switched off.
8. Every change goes through a pull request. Nothing is committed to `main`.
9. Never weaken a check to make a change pass.

## Planning documents

Design, standards, milestones and progress live outside this repository, in the
owner's `CRRS\scanner\` folder. Read `HANDOFF.md` there first.
