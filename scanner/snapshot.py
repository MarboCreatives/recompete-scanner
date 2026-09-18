"""Pipeline rows in, snapshot rows out. Suppression happens here.

M2-DESIGN sections 4 and 7. Pure functions: nothing here reads a network, opens
a database or prints. `report()` is the only thing that writes to the screen and
it takes counts, never rows.

THE ONE RULE THAT IS NOT THE SITE'S. The site keeps a contract if
`days_to_expiry >= 0`. This module keeps a contract if `end_date >= R`, where R
is the day the scan runs. They are the same question asked of two different
things and the difference is the whole reason M2 exists.

`days_to_expiry` is computed by ingest at DOWNLOAD time and then frozen into the
row. Measured on 17 September 2026 against two real snapshots two weeks apart:
every one of 25,042 matched contracts differed by exactly 14 days, and not one
end date had moved. A scanner that compared day counts would report 25,042
changes a fortnight and nothing that happened would be visible inside the noise.
So dates are compared and day counts are never compared. M2-DESIGN 2.2.

WHAT THE CALLER STILL HOLDS. The rows handed in keep their real supplier names;
this module copies before it suppresses, so it cannot reach back into somebody
else's list. That copy is deliberate and it puts an obligation on the caller:
the pipeline rows hold unsuppressed names and must never be written to a file,
a cache, an artifact or a log. M2-DESIGN 7. Only SnapshotRow objects leave here,
and those have been through the site's own suppression.
"""

from __future__ import annotations

import math
import os
import dataclasses
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, NamedTuple, Optional

from vendor import categories, ingest, names

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")


@dataclass(frozen=True)
class SnapshotRow:
    """One row of contract_snapshot, after suppression.

    Field for field the table in migration 0004, minus first_seen_run and
    last_seen_run. Those are the run's identity, not the contract's, and db.py
    sets them: a row's first_seen_run must survive every later run, and only a
    statement that has read the existing row can know it.

    The two supplier fields are left out of repr. They are the only fields that
    can carry a person's name: a row read back from contract_snapshot still
    holds whatever the rules of the week it was written let through, until
    resuppress() runs, and a name the rules miss sits in both. A repr goes
    wherever a row is logged, asserted about or formatted into an error.
    M2-DESIGN 7. Equality still compares them.
    """

    contract_key: str
    buyer_org_code: str
    reference_number: str
    buyer_org: str
    vendor_key: str = field(repr=False)
    vendor_display: str = field(repr=False)
    category_key: str
    contract_value: Optional[float]
    end_date: Optional[str]        # ISO, YYYY-MM-DD
    amendment_count: int


@dataclass(frozen=True)
class PublishedFact:
    """What this run's download says about one contract, live or not.

    diff.py needs to tell "no longer live" from "no longer published", and they
    are different questions. The government's dataset is historical — about 1.31
    million rows — and keeps a contract after it ends. So a contract that drops
    out of the live set has usually NOT left the published data: it ended, or an
    amendment pulled its end date into the past. Only a contract missing from the
    download altogether is "no longer in the published data", which is what
    CONTRACT_GONE means (M2-DESIGN 1).

    Deliberately carries no supplier name and no supplier key. It exists to
    answer "is it still published, and with what dates and value", and a
    structure that cannot hold a name cannot leak one. An event built from it
    takes its supplier key from the previous snapshot row, which has already been
    through suppression.
    """

    buyer_org_code: str
    reference_number: str
    end_date: Optional[str]
    contract_value: Optional[float]


class UnsuppressedRow(dict):
    """One pipeline row. A plain dict, except that printing it prints no value.

    It holds the supplier's name as published, before suppression. The default
    dict repr printed it, and so did every log line, f-string, assert message
    and traceback-with-locals that touched the row. M2-DESIGN 7.
    """

    __slots__ = ()

    def __repr__(self) -> str:
        return f"<pipeline row: {len(self)} fields, unsuppressed, not printed>"


class Pipeline(NamedTuple):
    """What snapshot.pipeline hands back. A NamedTuple so it still unpacks.

    Its repr is counts only. The default one printed every unsuppressed row, so
    one logging.error("bad run %s", pipe) in scan.py would have put every
    supplier name in the download into a public Actions log. str(), format(),
    %s and %r all go through __repr__. M2-DESIGN 7.
    """

    rows: list[dict[str, Any]]                       # live pipeline rows, unsuppressed
    refs: dict[tuple[str, str], str]                 # every (org, ref) -> contract_key
    conflicts: int                                   # pairs that pointed two ways
    published: dict[str, PublishedFact]              # every contract in the download

    def __repr__(self) -> str:
        return (
            f"Pipeline({len(self.rows):,} live rows, {len(self.refs):,} references, "
            f"{self.conflicts:,} conflicts, {len(self.published):,} published contracts)"
        )


@dataclass(frozen=True)
class SnapshotCounts:
    """Counts only. Never a name, a key or a reference number."""

    rows_in: int = 0
    kept: int = 0
    past_end_date: int = 0
    no_end_date: int = 0
    no_reference: int = 0
    no_vendor_name: int = 0
    unkeyed_company: int = 0
    suppressed: int = 0
    no_category_key: int = 0
    # Kept rows whose contract_key is ingest.build_contract_key's FALLBACK,
    # "{org}::REF::{ref}", used when a row has no procurement_id. That key
    # changes when the reference number changes, so an amendment to such a
    # contract arrives as a second contract. The first one does NOT end: the
    # dataset is historical, so its old row stays published and stays live
    # until its old end date, and the amendment's change is never reported on
    # it. diff.py says nothing about the second one either (see
    # is_keyed_by_reference). G24 says procurement_id is stable and the design
    # measured on it; this count is how PR C finds out how many contracts it
    # does not cover, rather than assuming.
    keyed_by_reference: int = 0

    @property
    def dropped(self) -> int:
        return (
            self.past_end_date
            + self.no_end_date
            + self.no_reference
            + self.no_vendor_name
            + self.unkeyed_company
        )


class RulesNotLoaded(RuntimeError):
    """The site's data files could not be read, so the rules are not the site's."""


def load_site_rules(vendor_dir: str = VENDOR) -> tuple[int, int]:
    """Fill the two module globals the copied rules read. Returns their sizes.

    Both of `load_vendor_allowlist` and `load_category_merges` treat a missing
    file as "nothing to load", which is the site's judgement and correct there:
    the site is one program, run from one directory, and an absent allowlist is
    visible in the pages it builds. The scanner is not watched while it runs, and
    the failure is silent in both directions:

      * an unloaded ALLOWLIST suppresses MORE, so RAYMOND CHABOT GRANT THORNTON
        would be withheld week after week and nothing would say so;
      * unloaded MERGES leave two spellings of one category as two keys.

    Neither is a privacy fault and both are wrong, so this refuses instead. It is
    stricter than the copied function on purpose, which is why it lives here and
    not in vendor/ where drift.py would rightly call it a difference.
    """
    allowlist_path = os.path.join(vendor_dir, "vendor_allowlist.txt")
    merges_path = os.path.join(vendor_dir, "category_merges.txt")
    for path in (allowlist_path, merges_path):
        if not os.path.exists(path):
            raise RulesNotLoaded(f"{os.path.basename(path)} is missing from {vendor_dir}")

    names.VENDOR_ALLOWLIST = names.load_vendor_allowlist(allowlist_path)
    categories.CATEGORY_MERGES = categories.load_category_merges(merges_path)
    if not names.VENDOR_ALLOWLIST:
        raise RulesNotLoaded("vendor_allowlist.txt loaded but held no entries")
    return len(names.VENDOR_ALLOWLIST), len(categories.CATEGORY_MERGES)


def pipeline(raw_rows: Iterable[dict[str, Any]], today: date) -> Pipeline:
    """Raw source rows to pipeline rows, in the order the steps have to happen.

    Returns the live pipeline rows, every (org, ref) pair seen, how many pairs
    conflicted, and what the download says about EVERY contract in it, live or
    not. That last is taken after deduplicate and before filter_recompete, which
    is the one point where the whole published dataset exists as one row per
    contract. See PublishedFact for why diff.py needs it.

    THE ORDER IS THE FUNCTION. Every step depends on the one before it, and
    three of the four dependencies are invisible until something is wrong:

      normalize            per row. Drops buyer_name, which is the only version
                           of "we do not publish it" that cannot be undone
                           later.

      collect_refs         HERE, before deduplicate, and nowhere else. It is the
                           rows about to be thrown away that carry the reference
                           numbers people are already watching. Run it one line
                           later and it returns one reference per contract,
                           which looks entirely reasonable and silently loses
                           every older watch key.

      deduplicate          collapses amendments onto the latest row and records
                           how many there were.

      derive_category_names  fills Contract.category_name from the commonest
                           description per commodity code. It reads the WHOLE
                           list, so it cannot run before the collapse and cannot
                           run per row. Forgetting it leaves category_name None,
                           and add_category_key then falls back to the raw
                           commodity code — so every contract gets a key that
                           looks plausible, is not a subject anybody could
                           browse, and fragments one category across dozens of
                           codes. Found by a test on 17 September 2026, not by
                           reading the site.

      filter_recompete     the site's selection: services and construction only,
                           the commodity types whose end dates mean the end of
                           the contract. This is what makes the scanner's
                           universe the same ~25,000 contracts the site shows.

    filter_recompete ALSO drops rows whose days_to_expiry is negative, and
    build_snapshot then filters again by date. That overlap is deliberate.
    days_to_expiry is computed by normalize against `today`, so on a live run
    the two agree; on anything else — a re-run over a saved download, PR C's
    historical check — only the date is right. The date is the authoritative
    test and is applied last, so it wins wherever they disagree.
    """
    normalized = [ingest.normalize(row, today=today) for row in raw_rows]
    refs, conflicts = ingest.collect_refs(normalized)
    deduped = ingest.deduplicate(normalized)
    ingest.derive_category_names(deduped)
    published = {
        c.contract_key: PublishedFact(
            buyer_org_code=(c.buyer_org_code or "").strip(),
            reference_number=(c.reference_number or "").strip(),
            end_date=c.delivery_date,
            contract_value=_as_float(c.contract_value),
        )
        for c in deduped
    }
    live = ingest.filter_recompete(deduped, window_months=None, services_only=True)
    rows = [UnsuppressedRow(_as_row(c)) for c in live]
    return Pipeline(rows, refs, conflicts, published)


def build_snapshot(
    rows: Iterable[dict[str, Any]], run_date: date
) -> tuple[list[SnapshotRow], SnapshotCounts]:
    """The live contracts, suppressed, as snapshot rows.

    `rows` are pipeline rows: dataclasses.asdict of ingest.Contract, AFTER
    ingest.deduplicate has collapsed amendments. They are not modified.

    The order of the two site rules below is the site's: add_category_key first,
    then suppress_individuals. Neither reads what the other writes, so the order
    is not load-bearing, but matching it means a reader comparing the two files
    is comparing like with like.
    """
    copies = [dict(r) for r in rows]
    rows_in = len(copies)

    # Live, by DATE. See the module docstring.
    live: list[dict[str, Any]] = []
    past_end_date = no_end_date = 0
    for r in copies:
        end = _as_date(r.get("delivery_date"))
        if end is None:
            no_end_date += 1
            continue
        if end < run_date:
            past_end_date += 1
            continue
        live.append(r)

    categories.add_category_key(live)
    suppressed = names.suppress_individuals(live)

    out: list[SnapshotRow] = []
    no_reference = no_vendor_name = unkeyed_company = no_category_key = 0
    keyed_by_reference = 0
    for r in live:
        org = (r.get("buyer_org_code") or "").strip()
        ref = (r.get("reference_number") or "").strip()
        if not org or not ref:
            # Nobody can watch this and nothing can link to it: the government's
            # own record is addressed by exactly this pair (G23), and so is a
            # watch key. contract_refs refuses half an empty pair for the same
            # reason.
            no_reference += 1
            continue

        display = (r.get("vendor_name") or "").strip()
        key = (r.get("vendor_key") or "").strip()
        if not display:
            # A contract with no supplier at all. Dropped rather than guessed
            # at: the honest label would be "supplier not stated", and writing
            # the withheld-individual label instead would assert something about
            # a person that may not be true (CODING-STANDARDS 4). It would also
            # be refused by contract_snapshot_withheld_pairing, because an empty
            # key with an empty name satisfies neither half.
            #
            # Expected to be zero on the real data. The count is here so PR C
            # measures it rather than assuming it.
            no_vendor_name += 1
            continue

        # Every row that leaves here must satisfy contract_snapshot_withheld_pairing
        # in migration 0004, because M2-DESIGN 6 rule 7 commits the whole week in
        # one transaction and a single refused row rolls all of it back. The
        # constraint is the tripwire; this is the enforcement point. Two shapes
        # would trip it, and the adversarial review of 17 September 2026 found
        # both by running them.
        if display == names.PERSON_LABEL:
            # The source itself carried the withheld label, rather than
            # suppress_individuals putting it there. The label means "this is a
            # private person", whoever wrote it, so there must be no key beside
            # it: a key is a watchable identity. suppress_individuals blanks the
            # key whenever it writes the label; this does the same for a label
            # that arrived already written.
            key = ""
        elif not key:
            # A real company whose name is nothing but legal and place words —
            # "The Company Inc", "Canada Ltd", "Holdings Group Inc".
            # ingest.vendor_key strips VENDOR_STOPWORDS and leaves nothing. The
            # site shows such a name with no supplier page, which is fine there.
            # Here it is a real name beside an empty key, which the pairing
            # constraint reads as suppression half-applied and refuses.
            #
            # Dropped and counted rather than kept, because keeping it needs
            # the constraint relaxed, and that is a change to the data model
            # that is Jon's to decide (CODING-STANDARDS 8). Not labelled as a
            # withheld individual, because it is not one (CODING-STANDARDS 4).
            # Not given an invented key, because that would be a second
            # vendor_key rule living outside the drift check. PR C measures how
            # many real contracts this is.
            unkeyed_company += 1
            continue

        contract_key = r.get("contract_key") or ""
        if is_keyed_by_reference(contract_key):
            keyed_by_reference += 1

        category_key = (r.get("category_key") or "").strip()
        if not category_key:
            no_category_key += 1

        out.append(
            SnapshotRow(
                contract_key=contract_key,
                buyer_org_code=org,
                reference_number=ref,
                buyer_org=(r.get("buyer_org") or "").strip(),
                vendor_key=key,
                vendor_display=display,
                category_key=category_key,
                contract_value=_as_float(r.get("contract_value")),
                end_date=r.get("delivery_date"),
                amendment_count=max(1, int(r.get("amendment_count") or 1)),
            )
        )

    counts = SnapshotCounts(
        rows_in=rows_in,
        kept=len(out),
        past_end_date=past_end_date,
        no_end_date=no_end_date,
        no_reference=no_reference,
        no_vendor_name=no_vendor_name,
        unkeyed_company=unkeyed_company,
        suppressed=suppressed,
        no_category_key=no_category_key,
        keyed_by_reference=keyed_by_reference,
    )
    return out, counts


def is_keyed_by_reference(contract_key: str) -> bool:
    """True for ingest.build_contract_key's fallback key, "{org}::REF::{ref}".

    One function, because two places ask: build_snapshot counts these, and
    diff.py will not call one a new award.
    """
    return "::REF::" in contract_key


def resuppress(row: SnapshotRow) -> SnapshotRow:
    """A STORED row, put through the name rules in force today.

    Every row in contract_snapshot was suppressed under the rules in force the
    week it was written. Those rules change: site PR #19 widened them in
    September, drift.py refuses to run until vendor/ is re-copied, and the
    allowlist is a correction channel that can take a company off as well as
    put one on. build_snapshot re-applies the rules to every LIVE row each week,
    but a row read back from the database — last week's contract that has just
    been withdrawn or terminated, or one that lapsed years ago — would otherwise
    carry forward, into a new event and back into the database, a name the site
    now withholds. The adversarial review found that path three ways on
    17 September 2026. CODING-STANDARDS 3: a later code path can reintroduce a
    name; the last function before output is the one that must be safe.

    The site's own suppress_individuals does the work, on a one-item list, so
    there is still exactly one implementation of the rule. A row already
    carrying the withheld label is left withheld: nothing here ever puts a name
    back.
    """
    if row.vendor_display == names.PERSON_LABEL:
        return row if row.vendor_key == "" else dataclasses.replace(row, vendor_key="")
    probe = [{"vendor_name": row.vendor_display, "vendor_key": row.vendor_key}]
    names.suppress_individuals(probe)
    display, key = probe[0]["vendor_name"], probe[0]["vendor_key"]
    if display == row.vendor_display and key == row.vendor_key:
        return row
    return dataclasses.replace(row, vendor_display=display, vendor_key=key)


def refs_in_snapshot(
    pairs: dict[tuple[str, str], str], rows: Iterable[SnapshotRow]
) -> dict[tuple[str, str], str]:
    """The (org, ref) pairs that point at a contract in THIS snapshot.

    `pairs` is ingest.collect_refs's mapping, which covers every amendment row
    including ones whose contract has long since ended. contract_refs has a
    foreign key to contract_snapshot, so a pair pointing anywhere else cannot be
    written. Filtering here rather than letting the insert fail keeps the whole
    run in one transaction: M2-DESIGN 6 rule 7.

    Pairs pointing at contracts recorded by EARLIER runs are dropped here and
    re-offered every run, which is correct and cheap — db.py inserts only the
    ones it does not already hold.
    """
    keys = {r.contract_key for r in rows}
    return {pair: key for pair, key in pairs.items() if key in keys}


def report(counts: SnapshotCounts) -> str:
    """One line of counts, for the workflow log. Never a name (M2-DESIGN 7)."""
    return (
        f"snapshot: {counts.rows_in:,} rows in, {counts.kept:,} live contracts kept, "
        f"{counts.dropped:,} dropped "
        f"({counts.past_end_date:,} past their end date, "
        f"{counts.no_end_date:,} with no end date, "
        f"{counts.no_reference:,} with no reference number, "
        f"{counts.no_vendor_name:,} with no supplier, "
        f"{counts.unkeyed_company:,} with a supplier name that has no key), "
        f"{counts.suppressed:,} supplier names withheld, "
        f"{counts.no_category_key:,} with no category, "
        f"{counts.keyed_by_reference:,} keyed by reference number"
    )


# --------------------------------------------------------------------------


def _as_row(contract: Any) -> dict[str, Any]:
    """An ingest.Contract as a plain dict, the shape the site's rules expect.

    dataclasses.asdict rather than vars(), because the site's suppress_individuals
    and add_category_key both take `list[dict]` and this is where the two shapes
    meet.
    """
    return dataclasses.asdict(contract)


def _as_date(value: Any) -> Optional[date]:
    """An ISO date string as a date. Anything else is None, never a guess."""
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


# contract_snapshot.contract_value is numeric(16,2) in migration 0004: fourteen
# digits before the point. PostgreSQL refuses anything from 10**14 up, and
# refuses infinity, with "numeric field overflow". One such row would roll back
# the whole week (M2-DESIGN 6 rule 7), and the next week, and every week after,
# because the source keeps the value. tests/test_schema_fit.py pins this to the
# migration's text.
LARGEST_STORABLE_VALUE = 10**14


def _as_float(value: Any) -> Optional[float]:
    """An amount, or None when it cannot be read OR cannot be stored.

    Unstorable is treated exactly like unreadable, which the rest of the code
    already handles: _keep_last_good keeps the last good amount, and diff.py
    says nothing from or to it. ingest.parse_money is a bare float(), so "inf",
    "nan" and a fifteen-digit typo all arrive here as numbers. Found by round
    three of the review, 18 September 2026. Whether the real data holds one
    has not been measured.
    """
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(round(number, 2)) >= LARGEST_STORABLE_VALUE:
        return None
    return number
