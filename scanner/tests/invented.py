"""Invented data for the tests. Nothing here came from the real source.

CODING-STANDARDS 3 forbids writing a suppressed name anywhere, including into a
committed fixture, so every supplier name below is made up. They were checked
against the real rules before being used, not guessed at: each name in
INDIVIDUALS is the name a rule was written for, and the comment says which.

The surnames QUILLERAN, VANTERPOOL and SMALLWOOD were chosen because they
appear nowhere in the government's vendor list and nowhere in
vendor/names.py's word lists, so a test asserting "this string must not appear
in the output" cannot pass by coincidence.

Rows are built by calling the REAL ingest.normalize on raw source-shaped dicts
rather than by hand-writing pipeline rows. A hand-written row would agree with
whatever the test expected; one that has been through the copied code agrees
with the copied code, which is the thing under test.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from typing import Any, Optional

import snapshot
from snapshot import SnapshotRow
from vendor import ingest

# The day every fixture is relative to. Fixed, so a test cannot start failing in
# March because it was written in September.
TODAY = date(2026, 9, 17)


# --------------------------------------------------------------------------
# Invented supplier names
# --------------------------------------------------------------------------

# Names the site's rules DO withhold. The comment is the rule in is_individual
# each one exercises; test_suppression.py asserts every one of them is caught,
# so a rule quietly narrowing shows up as a failure here.
INDIVIDUALS: tuple[tuple[str, str], ...] = (
    ("QUILLERAN, Marisol", "rule 1 — one comma, one token each side"),
    ("VANTERPOOL, Dana Marie", "rule 1 — two tokens on the right"),
    ("DANA QUILLERAN", "rule 2 — two words, one of them a listed given name"),
    ("TREVOR VANTERPOOL SMALLWOOD", "rule 2 — three words"),
    ("TREVOR QUILLERAN PHOTOGRAPHIE ARTISANALE", "rule 3 — long, opens on a given name"),
    ("Chief Dana Quilleran Vanterpool", "rule 3 behind a title, site PR #19"),
    ("Dana La Vanterpool", "a particle in the MIDDLE is a surname, site PR #19"),
)

# Names the site's rules do NOT withhold, and must not.
ORGANISATIONS: tuple[tuple[str, str], ...] = (
    ("Northwind Widgets Inc", "INC is a corporate word"),
    ("Le Groupe Quilleran", "a particle in FIRST position is a company"),
    ("Vanterpool Systems Corporation", "SYSTEMS and CORPORATION"),
    ("Smallwood Marine Logistics Ltd", "three corporate words"),
)

# On vendor_allowlist.txt: the rules read it as a person and the site overrides
# them. Copied from the real file because it IS the real correction channel, and
# it is a company's name, not a person's.
ALLOWLISTED_ORGANISATION = "RAYMOND CHABOT GRANT THORNTON"

# A real person's name that the rules MISS, and honestly so: "marisol" is on no
# given-name list, and is_individual's own docstring says the given-name test is
# not a census. Kept as a fixture because a test that pretended otherwise would
# be claiming a guarantee the code does not give.
NAME_THE_RULES_MISS = "Marisol La Vanterpool"

ALL_INVENTED_NAMES: tuple[str, ...] = tuple(
    [n for n, _ in INDIVIDUALS]
    + [n for n, _ in ORGANISATIONS]
    + [ALLOWLISTED_ORGANISATION, NAME_THE_RULES_MISS]
)

# Every distinctive token in those names. A log or a row is searched for these,
# not for the whole name, because "QUILLERAN, Marisol" reaching a log as
# "Quilleran" would be just as much of a leak.
INVENTED_TOKENS: tuple[str, ...] = (
    "QUILLERAN",
    "VANTERPOOL",
    "SMALLWOOD",
    "MARISOL",
    "NORTHWIND",
    "PHOTOGRAPHIE",
    "ARTISANALE",
)

# Invented reference numbers. The prefix is not one the government issues, so a
# test asserting one never reaches a log cannot pass by luck either.
REF_PREFIX = "ZZ-TEST"


# --------------------------------------------------------------------------
# Raw source rows and pipeline rows
# --------------------------------------------------------------------------


def source_row(
    *,
    org: str = "aa-invented",
    procurement_id: str = "PID-0001",
    reference: str = f"{REF_PREFIX}-0001",
    vendor_name: str = "Northwind Widgets Inc",
    end_date: str = "2027-03-31",
    value: float = 250_000.0,
    contract_date: str = "2025-04-01",
    commodity_type: str = "S",
    description_en: str = "Other professional services not elsewhere specified",
    **over: Any,
) -> dict[str, Any]:
    """One raw row, shaped the way the CKAN datastore hands them over.

    Deliberately includes buyer_name. The source really does carry it, ingest
    really does drop it, and a fixture without it could not prove that.
    """
    row: dict[str, Any] = {
        "_id": 1,
        "owner_org": org,
        "owner_org_title": "An Invented Department | Un ministere invente",
        "buyer_name": "SOMEBODY, Invented",
        "procurement_id": procurement_id,
        "reference_number": reference,
        "vendor_name": vendor_name,
        "vendor_postal_code": "K1A",
        "country_of_vendor": "CA",
        "description_en": description_en,
        "description_fr": "Autres services professionnels",
        "comments_en": "",
        "commodity_code": "R019",
        "commodity_type": commodity_type,
        "economic_object_code": "0499",
        "contract_value": value,
        "original_value": value,
        "amendment_value": 0,
        "contract_date": contract_date,
        "contract_period_start": "2025-04-01",
        "delivery_date": end_date,
        "number_of_bids": 3,
        "solicitation_procedure": "TC",
        "limited_tendering_reason": "",
        "standing_offer_number": "",
        "instrument_type": "C",
        "reporting_period": "2025-2026-Q4",
    }
    row.update(over)
    return row


def pipeline_rows(raws: list[dict[str, Any]], today: date = TODAY) -> list[dict[str, Any]]:
    """Raw rows through the real ingest TRANSFORMS: normalize, dedup, name.

    Deliberately stops short of filter_recompete, which is the site's SELECTION
    step. Including it here would hide build_snapshot's own date filter behind a
    day-count filter that usually agrees with it, and the cases that matter are
    exactly the ones where they do not. `scan_pipeline` below is the whole
    thing, and test_snapshot.py checks the two against each other.

    derive_category_names is in here because leaving it out is a silent fault,
    not a loud one: add_category_key falls back to the raw commodity code, so
    every row gets a category key that looks like a key and is not one. That is
    how this function was wrong when it was first written.
    """
    normalized = [ingest.normalize(r, today=today) for r in raws]
    deduped = ingest.deduplicate(normalized)
    ingest.derive_category_names(deduped)
    return [dataclasses.asdict(c) for c in deduped]


def scan_pipeline(raws: list[dict[str, Any]], today: date = TODAY):
    """The whole of what a real scan runs, ordering included."""
    return snapshot.pipeline(raws, today)


def refs_of(raws: list[dict[str, Any]], today: date = TODAY) -> dict[tuple[str, str], str]:
    """The scanner's one addition to ingest, on the rows BEFORE dedup."""
    normalized = [ingest.normalize(r, today=today) for r in raws]
    mapping, _conflicts = ingest.collect_refs(normalized)
    return mapping


# --------------------------------------------------------------------------
# Snapshot rows, for the diff tests
# --------------------------------------------------------------------------


def snapshot_row(
    *,
    contract_key: str = "aa-invented::PID-0001",
    org: str = "aa-invented",
    reference: str = f"{REF_PREFIX}-0001",
    vendor_key: str = "northwind widgets",
    vendor_display: str = "Northwind Widgets Inc",
    category_key: str = "other professional services not elsewhere specified",
    value: Optional[float] = 250_000.0,
    end_date: Optional[str] = "2027-03-31",
    amendment_count: int = 1,
) -> SnapshotRow:
    return SnapshotRow(
        contract_key=contract_key,
        buyer_org_code=org,
        reference_number=reference,
        buyer_org="An Invented Department | Un ministere invente",
        vendor_key=vendor_key,
        vendor_display=vendor_display,
        category_key=category_key,
        contract_value=value,
        end_date=end_date,
        amendment_count=amendment_count,
    )


def by_key(rows: list[SnapshotRow]) -> dict[str, SnapshotRow]:
    return {r.contract_key: r for r in rows}


def background(n: int = 60) -> list[dict[str, Any]]:
    """Stable live contracts that never change, as raw rows.

    The refusal rules are percentages of last week's live contracts, so a
    multi-week case about ONE contract would be refused the moment that one
    contract moved. Real weeks have ~25,000 contracts around the one that
    changed; this is the smallest honest stand-in for them.
    """
    return [
        source_row(procurement_id=f"PID-BG{i:03d}", reference=f"{REF_PREFIX}-BG{i:03d}",
                   end_date="2029-06-30")
        for i in range(n)
    ]


class WeeklyLoop:
    """The weekly run exactly as PR B says the writer (PR D) must do it.

    Every case elsewhere looks at ONE run. The review of 17 September 2026 found
    that the faults which mattered most were invisible to one run and only
    appeared across several: two events contradicting each other, a change
    absorbed between runs, an old contract announced as new. This drives the
    real pipeline, week after week, holding contract_snapshot the way
    diff.rows_to_record says it must be held:

      * previous_live is the rows last written by the last run that was NOT
        refused — M2-DESIGN 6's "last run with status ok or baseline", which is
        not the same thing as "the previous run";
      * Record.live rows move last_seen_run to this run;
      * Record.refreshed rows keep the last_seen_run they had;
      * a refused run writes nothing at all.
    """

    def __init__(self) -> None:
        self.state: dict[str, tuple[SnapshotRow, int]] = {}
        self.last_ok: Optional[int] = None
        self.runs = 0

    def run(self, raws: list[dict[str, Any]], run_date: date,
            *, self_tests_passed: bool = True, drift_passed: bool = True):
        import diff  # here, so importing the fixtures never drags diff in first

        pipe = snapshot.pipeline(raws, run_date)
        current, _ = snapshot.build_snapshot(pipe.rows, run_date)
        run_id = self.runs
        self.runs += 1
        baseline = self.last_ok is None
        previous_live = {k: row for k, (row, seen) in self.state.items()
                         if not baseline and seen == self.last_ok}
        ever_seen = {k: row for k, (row, _seen) in self.state.items()}
        reason, events, counts = diff.run_diff(
            previous_live, ever_seen, current, pipe.published, run_date,
            is_baseline=baseline, self_tests_passed=self_tests_passed,
            drift_passed=drift_passed,
            # The run previous_live came from: what a real repeat of a change
            # is told apart by, in its dedupe_key. None only on the baseline.
            base_run=self.last_ok,
        )
        if reason is None:
            record = diff.rows_to_record(previous_live, ever_seen, current, pipe.published,
                                           run_date=run_date)
            for row in record.live:
                self.state[row.contract_key] = (row, run_id)
            for row in record.refreshed:
                self.state[row.contract_key] = (row, self.state[row.contract_key][1])
            self.last_ok = run_id
        return reason, events, counts

    def recorded(self, key: str) -> Optional[SnapshotRow]:
        held = self.state.get(key)
        return held[0] if held else None


def published_of(rows) -> dict[str, "snapshot.PublishedFact"]:
    """A download holding exactly these contracts and nothing else.

    The default the diff tests use is published_of(<the rows live now>): a
    download in which nothing that left the live set is still there. That is
    the harshest world for CONTRACT_GONE and the right one for testing it in
    isolation. It is NOT what the real data looks like — the government keeps a
    contract in the dataset after it ends — so the cases that matter about
    that, termination above all, pass their own `published` and say so.
    """
    return {
        r.contract_key: snapshot.PublishedFact(
            buyer_org_code=r.buyer_org_code,
            reference_number=r.reference_number,
            end_date=r.end_date,
            contract_value=r.contract_value,
        )
        for r in rows
    }


def days(n: int, from_day: date = TODAY) -> str:
    return (from_day + timedelta(days=n)).isoformat()
