"""Two snapshots in, events out. M2-DESIGN section 6.

Pure functions. Nothing here opens a socket, a file or a database, and nothing
here prints; `report()` returns a line of counts for the caller to print.

The exit criterion for M2 is "zero invented events". Everything below is shaped
by that, so it is worth saying what the four ways to invent one are, because
each rule exists to close exactly one of them.

  1. COMPARING DAY COUNTS. `days_to_expiry` is frozen at download time, so on
     two snapshots a fortnight apart it differs by 14 on every contract that has
     not changed at all. Measured: 25,042 of them. This module never reads it.
     It compares dates and amounts.

  2. THE FIRST RUN. With nothing to compare against, all 25,000 live contracts
     look new. A baseline run emits nothing and says so in scan_runs.status.

  3. A CONTRACT THAT SIMPLY ENDED. 215 of the 257 contracts that left the data
     between two real snapshots had eleven days or fewer left. A contract
     passing its end date is not news; CONTRACT_GONE fires only when one
     disappears BEFORE its end date.

  4. AN AMENDMENT READ AS A NEW CONTRACT. An amendment usually arrives under a
     new reference number, so change detection keys on contract_key, which is
     stable across amendments, and never on the reference number.

  5. "NOT LIVE" READ AS "NOT PUBLISHED". Added 17 September 2026, after an
     adversarial review found it three separate ways. The government's dataset
     is historical and keeps a contract after it ends. So when an amendment
     pulls a contract's end date into the past — a termination — the contract
     drops out of the LIVE set while staying in the published data with its new
     date. Section 6 of the design defines CONTRACT_GONE against the live set,
     which fired "No longer in the published data. It was due to end 31 March
     2028." for a contract that was right there, published, ending last week.
     Section 1 defines it as "no longer in the published data", and that is the
     definition the reader sees, so that is the one implemented: CONTRACT_GONE
     needs the contract to be missing from the DOWNLOAD, not merely from the
     live set. The termination itself is then reported truthfully, as the
     EXPIRY_MOVED it is.

  6. AN OLD CONTRACT READ AS A NEW AWARD. Found by the same review, late, by
     three lenses. contract_snapshot holds only contracts that were live at
     some run. A contract that ended before the baseline was in the download
     but was never recorded, so when an option year makes it live again it
     has no row, and the first version called it "New contract: $150,000" —
     about a 2024 contract amended once. NEW_AWARD now also needs the contract
     to have no amendments yet (amendment_count 1). An amended contract the
     scanner has never held says nothing and is counted as new_but_amended.
     That cannot invent an award. It can miss one: a genuinely new contract
     already amended before its first publication. Which of the two the real
     data holds is measured in PR C, and the permanent rule — remembering
     every contract earlier downloads held, which needs a new table — is
     Jon's decision after that (PROGRESS.md, 17 September).

  7. AN AMENDMENT UNDER A NEW REFERENCE, ON A CONTRACT WITH NO PROCUREMENT ID.
     Found by round three of the review, run on 18 September 2026. Without a
     procurement_id, ingest keys the contract on its reference number, so an
     amendment under a new reference arrives as a second contract with no
     amendments, and passed point 6's test. It is not new. NEW_AWARD is
     therefore never emitted for a reference-keyed contract; it is counted as
     new_by_reference, and PR C measures how many real awards that misses.

AND ONE WAY TO LOSE ONE

  An unreadable row is not an ending. Found by the same round. A contract whose
  latest amendment has a blank or unreadable end date, or no reference, leaves
  the live set while its known end date is still ahead. Recorded as not live,
  it left previous_live for good, so its later termination or withdrawal was
  never reported. Such a contract is now KEPT UNDER WATCH (_kept_under_watch):
  recorded as live, with its last good row, until its known end date passes.

FOUR INPUTS, BECAUSE THERE ARE FOUR QUESTIONS

  previous_live  the contracts that were live at the last run with status ok or
                 baseline. Only these can "go": CONTRACT_GONE is about
                 something that was there last week.

  ever_seen      the last recorded row for EVERY contract contract_snapshot has
                 ever held. NEW_AWARD needs "never seen", and a contract that
                 comes back after an absence is compared against the last state
                 the scanner recorded for it, not skipped. Skipping it lost the
                 change for good, because the next run then compares against
                 the new values — and it silently missed an option year taken
                 up on a contract that had already lapsed, which is exactly the
                 event a recompete watcher most needs.

  current        the contracts live now, after suppression.

  published      what this run's download says about every contract in it,
                 live or not. It answers "is this still published, and with
                 what dates", and it carries no supplier name at all.

previous_live and ever_seen have to be separate. contract_snapshot keeps a row
after a contract leaves the data, so a watch on it still resolves — which means
"in the snapshot table" is not the same as "was live last week". Using one for
both would fire CONTRACT_GONE every run for every contract that has ever ended.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Iterable, Mapping, NamedTuple, Optional

from snapshot import PublishedFact, SnapshotRow, is_keyed_by_reference, resuppress

EXPIRY_MOVED = "EXPIRY_MOVED"
VALUE_CHANGED = "VALUE_CHANGED"
CONTRACT_GONE = "CONTRACT_GONE"
NEW_AWARD = "NEW_AWARD"
EVENT_TYPES = (EXPIRY_MOVED, VALUE_CHANGED, CONTRACT_GONE, NEW_AWARD)

# A contract's value is amended by a few dollars often enough that reporting it
# would bury the amendments that matter. M2-DESIGN 6.
VALUE_TOLERANCE = 1.0

# M2-DESIGN 6.6. Starting values, not measured ones: the design says so in as
# many words and asks for the real per-run figures to be recorded in PROGRESS.md
# for the first month and these tuned from them. Until that happens they are a
# guess, and a guess that refuses a good run costs a week of events while a
# guess that accepts a bad one publishes wrong ones. That asymmetry is why they
# start tight.
LIVE_DROP_LIMIT = 0.10
GONE_RATE_LIMIT = 0.05

# The four codes scan_runs.refusal_reason accepts. Same four as the CHECK
# constraint in migration 0004; tests/test_diff.py pins them together.
REFUSAL_SELF_TEST = "self_test"
REFUSAL_DRIFT = "drift"
REFUSAL_LIVE_COUNT_DROP = "live_count_drop"
REFUSAL_GONE_RATE = "gone_rate"


@dataclass(frozen=True)
class Event:
    """One row of `events`, minus the columns only the writer can fill.

    occurred_at, detected_at and scan_run_id are not here. This module has no
    clock and no run: db.py sets all three from the run record, so there is one
    answer to "when" rather than two that can disagree.

    payload carries public facts only. No supplier name beyond what suppression
    already allowed through, no buyer name ever — events_no_buyer_name in
    0001_init.sql refuses the insert if one appears.
    """

    event_type: str
    contract_key: Optional[str]
    contract_ref: Optional[str]      # "{org},{ref}" AS AT this event
    vendor_key: Optional[str]
    dedupe_key: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DiffCounts:
    """Counts only. Never a name, a key or a reference number."""

    previous_live: int = 0
    current_live: int = 0
    baseline: bool = False
    matched: int = 0
    expiry_moved: int = 0
    value_changed: int = 0
    contract_gone: int = 0
    new_award: int = 0
    gone_natural: int = 0
    gone_candidates: int = 0
    new_award_withheld: int = 0
    # Never recorded but already amended: an old contract, not a new award.
    new_but_amended: int = 0
    # Never recorded, keyed by reference number: possibly an amendment. Point 7.
    new_by_reference: int = 0
    returned: int = 0
    # Left the live set but still in the download: ended, terminated early, or
    # dropped by build_snapshot. Compared against what the download says, never
    # reported as gone.
    still_published: int = 0
    # Of those, the ones whose row cannot be read while their known end date is
    # still ahead. Recorded as live, so they stay in previous_live.
    kept_under_watch: int = 0
    dates_unusable: int = 0
    values_unusable: int = 0

    @property
    def total_events(self) -> int:
        return self.expiry_moved + self.value_changed + self.contract_gone + self.new_award


def refusal_reason(
    *,
    self_tests_passed: bool,
    drift_passed: bool,
    previous_live: int,
    current_live: int,
    gone_candidates: int,
) -> Optional[str]:
    """The code to record, or None to go ahead. M2-DESIGN 6.6.

    Checked in order of how fundamental the doubt is, which is not the order
    section 6.6 lists them in — the section is a list, not a sequence. A failed
    self-test means the code is wrong, so nothing it computed can be trusted,
    including the two counts below. Drift means the rules are wrong, same
    argument. Only then is it worth asking whether the DATA looks wrong.

    `gone_candidates` is the number of CONTRACT_GONE events the diff WOULD emit,
    not the number it did. That is the point: the check has to see the damage
    before it is committed, and the run then writes nothing at all.
    """
    if not self_tests_passed:
        return REFUSAL_SELF_TEST
    if not drift_passed:
        return REFUSAL_DRIFT

    # Both data checks need a previous run to be relative to. On the baseline
    # there is none, and a percentage of zero is not a small number, it is not
    # a number. Letting these fire on the first run would refuse every first
    # run there will ever be.
    if previous_live > 0:
        if current_live < previous_live * (1 - LIVE_DROP_LIMIT):
            return REFUSAL_LIVE_COUNT_DROP
        if gone_candidates > previous_live * GONE_RATE_LIMIT:
            return REFUSAL_GONE_RATE
    return None


def diff(
    previous_live: Mapping[str, SnapshotRow],
    ever_seen: Mapping[str, SnapshotRow],
    current: Iterable[SnapshotRow],
    published: Mapping[str, PublishedFact],
    run_date: date,
    is_baseline: bool = False,
) -> tuple[list[Event], DiffCounts]:
    """Every event these snapshots justify, and the counts behind them.

    See the module docstring for what each of the four inputs is for.
    """
    now_by_key = {r.contract_key: r for r in current}
    last_known = _last_known(previous_live, ever_seen)

    if is_baseline:
        # M2-DESIGN 6 rule 1. Not "emit and discard": nothing is computed, so
        # there is no list lying around for a later change to start writing.
        return [], DiffCounts(
            previous_live=len(previous_live),
            current_live=len(now_by_key),
            baseline=True,
        )

    events: list[Event] = []
    tally: Counter[str] = Counter()

    for key, now in now_by_key.items():
        before = last_known.get(key)

        if before is None:
            if not now.vendor_key:
                # M2-DESIGN 6 rule 4. The snapshot row is still written; the
                # event is not. The only people a NEW_AWARD could reach are
                # supplier watchers, and a withheld individual has no watchable
                # key for anyone to have followed.
                tally["new_award_withheld"] += 1
            elif now.amendment_count > 1:
                # Never recorded, but already amended: this is an old contract
                # the scanner simply never held, not a new award. See point 6
                # in the module docstring. Said nothing about, counted, and
                # recorded (it is in `current`), so every later change to it is
                # compared and reported truthfully.
                tally["new_but_amended"] += 1
            elif is_keyed_by_reference(key):
                # Point 7. Keyed by a reference number, which changes with
                # every amendment, so "never seen" does not mean "new".
                tally["new_by_reference"] += 1
            else:
                events.append(_new_award(now))
                tally["new_award"] += 1
            continue

        if key in previous_live:
            tally["matched"] += 1
        else:
            # Absent last run, present now, known from an earlier one. Compared
            # against the last state recorded for it, so a change made while it
            # was away is reported rather than lost. An option year taken up on
            # a contract that had already lapsed arrives exactly this way.
            tally["returned"] += 1

        _compare(before, now, events, tally)

    for key in previous_live:
        if key in now_by_key:
            continue
        # From last_known, not previous_live, so the supplier has been through
        # today's name rules. See snapshot.resuppress.
        before = last_known[key]

        fact = published.get(key)
        if fact is not None:
            # Out of the live set but STILL IN THE DOWNLOAD. It ended, or an
            # amendment pulled its end date into the past, or build_snapshot
            # could not use its row. None of those is "no longer in the
            # published data", so none of them is CONTRACT_GONE. Whatever did
            # change is reported as what it is: a termination is an EXPIRY_MOVED
            # with a negative days_moved.
            tally["still_published"] += 1
            if _kept_under_watch(before, fact, run_date):
                tally["kept_under_watch"] += 1
            if fact.reference_number:
                _compare(before, _as_row(before, fact), events, tally)
            else:
                tally["dates_unusable"] += 1
            continue

        end = _as_date(before.end_date)
        if end is None:
            # Cannot tell an ending from a disappearance. Says nothing.
            tally["dates_unusable"] += 1
            continue
        if end < run_date:
            # M2-DESIGN 6 rule 3. It reached its end date and left. That is the
            # ordinary life of a contract, not news. 215 of 257 departures
            # between two real snapshots were this.
            tally["gone_natural"] += 1
            continue
        events.append(_contract_gone(before))
        tally["contract_gone"] += 1

    counts = DiffCounts(
        previous_live=len(previous_live),
        current_live=len(now_by_key),
        baseline=False,
        matched=tally["matched"],
        expiry_moved=tally["expiry_moved"],
        value_changed=tally["value_changed"],
        contract_gone=tally["contract_gone"],
        new_award=tally["new_award"],
        gone_natural=tally["gone_natural"],
        gone_candidates=tally["contract_gone"],
        new_award_withheld=tally["new_award_withheld"],
        new_but_amended=tally["new_but_amended"],
        new_by_reference=tally["new_by_reference"],
        returned=tally["returned"],
        still_published=tally["still_published"],
        kept_under_watch=tally["kept_under_watch"],
        dates_unusable=tally["dates_unusable"],
        values_unusable=tally["values_unusable"],
    )
    return events, counts


def _stored(
    previous_live: Mapping[str, SnapshotRow], ever_seen: Mapping[str, SnapshotRow]
) -> dict[str, SnapshotRow]:
    """What contract_snapshot holds for every contract ever seen, as stored.

    One function because two need it, diff() and rows_to_record(), and the
    precedence below is a rule: written twice it is two rules that can drift.

    A contract live last run has by definition been seen, and its previous_live
    row IS its last recorded state, so previous_live wins wherever both hold a
    row. If the older row won, an unchanged contract would be compared against
    how it looked months ago and an event invented from a change already
    reported. Taking the union rather than trusting the caller means a partial
    ever_seen can only cost an event, never invent one.
    """
    return {**ever_seen, **previous_live}


def _last_known(
    previous_live: Mapping[str, SnapshotRow], ever_seen: Mapping[str, SnapshotRow]
) -> dict[str, SnapshotRow]:
    """The stored rows, with each supplier put through today's name rules.

    This, not _stored, is what every comparison and every event reads, so no
    supplier field that leaves this module was judged by an older rule.
    """
    return {k: resuppress(r) for k, r in _stored(previous_live, ever_seen).items()}


def _keep_last_good(before: Optional[SnapshotRow], after: SnapshotRow) -> SnapshotRow:
    """`after`, except that a blank date or value never replaces a known one.

    A published row with a blank or unreadable end date or value is not a
    trustworthy replacement for a known one: _compare already says nothing
    about it. Recording the blank would make it the base for the NEXT
    comparison too, and that one would say nothing either — so a real
    extension, the event a recompete watcher most needs, would be lost for good.
    Found four ways by the review on 17 September 2026. The rest of the row,
    including the reference, still moves on.
    """
    if before is None:
        return after
    keep: dict[str, Any] = {}
    if after.end_date is None and before.end_date is not None:
        keep["end_date"] = before.end_date
    if after.contract_value is None and before.contract_value is not None:
        keep["contract_value"] = before.contract_value
    return replace(after, **keep) if keep else after


def _kept_under_watch(
    last_known: SnapshotRow, fact: Optional[PublishedFact], run_date: date
) -> bool:
    """Out of the live set only because its row cannot be read, not because it ended.

    One function, because diff() counts these and rows_to_record() records
    them, and written twice that would be two rules that could drift apart.

    True when the contract is still in the download, its latest row has a blank
    or unreadable end date or no reference, and the last end date the scanner
    knew is still on or after the run date. Such a contract has not ended; the
    scanner simply cannot read what it says this week. Recording it as not live
    took it out of previous_live for good, so a later termination (a real
    EXPIRY_MOVED) or withdrawal (a real CONTRACT_GONE) was never reported.
    Round three of the review found both on 18 September 2026.

    It stops once the known end date passes: from then on it has, as far as
    anything readable says, ended, and a contract that ended is not news.
    """
    if fact is None:
        return False
    if fact.reference_number and _as_date(fact.end_date) is not None:
        return False
    end = _as_date(last_known.end_date)
    return end is not None and end >= run_date


def _compare(
    before: SnapshotRow, now: SnapshotRow, events: list[Event], tally: Counter[str]
) -> None:
    """EXPIRY_MOVED and VALUE_CHANGED between two states of one contract.

    One place, because three paths need it: a contract live both times, one
    that came back, and one still published but no longer live. Written three
    times it would be three rules that could drift apart.

    M2-DESIGN 6 rule 5: one amendment can move date and value together, and that
    is two events. Neither test below is an elif of the other, which is the
    whole of how that rule is implemented.
    """
    old_end, new_end = _as_date(before.end_date), _as_date(now.end_date)
    if old_end is None or new_end is None:
        tally["dates_unusable"] += 1
    elif old_end != new_end:
        events.append(_expiry_moved(before, now, old_end, new_end))
        tally["expiry_moved"] += 1

    old_value, new_value = _as_money(before.contract_value), _as_money(now.contract_value)
    if old_value is None or new_value is None:
        tally["values_unusable"] += 1
    elif abs(new_value - old_value) > VALUE_TOLERANCE:
        events.append(_value_changed(before, now, old_value, new_value))
        tally["value_changed"] += 1


def _as_row(before: SnapshotRow, fact: PublishedFact) -> SnapshotRow:
    """What the download now says, dressed as a row the comparison can read.

    The dates, value and reference come from the download. The supplier comes
    from `before`, the previous snapshot row, which has already been through
    suppression. PublishedFact carries no supplier at all, on purpose, so there
    is no path here by which an unsuppressed name could reach an event.

    The price of that, found in round two of the review and kept on purpose: if
    an amendment BOTH takes a contract out of the live set AND changes its
    supplier, the event carries the supplier the scanner last saw live, not the
    new one. The dates and value in the event are still true; the attribution is
    a week stale. Reaching it needs a supplier change and a termination in the
    same amendment. The alternative is suppressing every row of the whole
    download to build PublishedFact, which puts unsuppressed names into a
    second structure to save one label — the wrong way round for this project.
    A contract that stays live takes its new supplier through the live path, as
    it should.
    """
    return replace(
        before,
        buyer_org_code=fact.buyer_org_code or before.buyer_org_code,
        reference_number=fact.reference_number,
        end_date=fact.end_date,
        contract_value=fact.contract_value,
    )


class Record(NamedTuple):
    """What contract_snapshot must hold once this run commits.

    live       every contract live now, plus every contract kept under watch
               (_kept_under_watch) with its last good row. Upserted;
               last_seen_run moves to this run, which is what puts it in next
               run's previous_live.
    refreshed  contracts NOT live now but still in the download, whose recorded
               dates, value or reference no longer match what is published.
               Their facts are updated; last_seen_run is left alone, so they do
               not reappear in previous_live and cannot "go" a second time.
    """

    live: list[SnapshotRow]
    refreshed: list[SnapshotRow]


def rows_to_record(
    previous_live: Mapping[str, SnapshotRow],
    ever_seen: Mapping[str, SnapshotRow],
    current: Iterable[SnapshotRow],
    published: Mapping[str, PublishedFact],
    *,
    run_date: date,
) -> Record:
    """Which rows the writer must store for the NEXT run's diff to be true.

    THE RULE: contract_snapshot holds, for each contract, the last state an
    event has already accounted for. Every event then moves FROM where the
    previous one left off, so consecutive events on one contract never
    contradict each other and no change falls between two of them.

    Three things follow, and each was measured wrong before it was written down:

    1. A contract live last week that has left the live set but is still in the
       download — terminated, or simply ended — IS refreshed. diff() has just
       compared it and reported what changed, so its new facts are accounted
       for. Without this, terminated then reinstated gave:

           the government's record   2027-03-31  ->  2026-09-10  ->  2028-03-31
           run 2 said                moved 2027-03-31 -> 2026-09-10     (true)
           run 3 said                moved 2027-03-31 -> 2028-03-31     (false)

    2. A contract that was NOT live last week is NOT refreshed, even if its
       published facts moved. diff() said nothing about it, so nothing has
       accounted for the move, and it must still be there to compare against
       when the contract comes back. The first version refreshed these too and
       absorbed their changes silently: a lapsed contract's value fell and rose
       again with no event, then the next event started from a figure no event
       had ever shown. Round two of the review found that four ways.

    3. A blank date or value in the download never replaces a known one
       (_keep_last_good), in the live rows or the refreshed ones.

    4. A contract live last week that left the live set only because its row
       cannot be read, while its known end date is still ahead, is recorded as
       LIVE, not refreshed (_kept_under_watch). Otherwise rule 1's "refreshed,
       last_seen_run left alone" drops it from previous_live, and its later
       termination or withdrawal is never reported. `run_date` is required for
       this, and has no default: a writer that forgot it would lose exactly
       those events and nothing would say so.

    Separately, every stored row goes back through today's name rules
    (snapshot.resuppress). A row whose supplier the rules now withhold is
    returned in `refreshed` with its facts untouched, so the writer scrubs the
    name out of contract_snapshot even for a contract that will never be live
    again.
    """
    stored = _stored(previous_live, ever_seen)
    last_known = _last_known(previous_live, ever_seen)
    now_keys = {r.contract_key for r in current}

    live = [_keep_last_good(last_known.get(r.contract_key), r) for r in current]

    refreshed: list[SnapshotRow] = []
    for key, as_stored in stored.items():
        if key in now_keys:
            continue
        after = last_known[key]
        if key in previous_live:
            fact = published.get(key)
            if fact is not None and fact.reference_number:
                after = _keep_last_good(after, _as_row(after, fact))
            # Not in the download, or not linkable: nothing trustworthy to
            # record in its place, so the last good state stands.
            if _kept_under_watch(last_known[key], fact, run_date):
                live.append(after)
                continue
        if after != as_stored:
            refreshed.append(after)
    return Record(live, refreshed)


def run_diff(
    previous_live: Mapping[str, SnapshotRow],
    ever_seen: Mapping[str, SnapshotRow],
    current: Iterable[SnapshotRow],
    published: Mapping[str, PublishedFact],
    run_date: date,
    *,
    is_baseline: bool = False,
    self_tests_passed: bool = True,
    drift_passed: bool = True,
) -> tuple[Optional[str], list[Event], DiffCounts]:
    """The diff, and the refusal decision, in the order they have to happen.

    Returns (refusal code or None, events, counts). **On a refusal the event
    list is empty**, which is M2-DESIGN 6.6's "the run writes nothing": the
    caller cannot write what it was not given, so a refusal that is ignored
    still cannot publish an event.

    The counts survive a refusal on purpose. They are what tuning the two
    thresholds from real figures needs, and they hold no name.
    """
    events, counts = diff(previous_live, ever_seen, current, published, run_date, is_baseline)
    reason = refusal_reason(
        self_tests_passed=self_tests_passed,
        drift_passed=drift_passed,
        previous_live=counts.previous_live,
        # Like with like. previous_live holds last week's contracts kept under
        # watch as well as the live ones, so this week's side counts both.
        # Compared against live alone, every contract kept under watch would
        # count as a drop every week it stays kept, and enough of them would
        # refuse every run. Only kept contracts are added back, never every
        # contract still published: a wave of readable terminations must
        # still be refused. A kept contract CAN produce an event while kept:
        # a VALUE_CHANGED, when its unreadable row still has a reference and a
        # new amount. That event is true of the download, like any other.
        # (The first version of this comment said they could produce none.
        # The review of 84fbbb3 showed otherwise, 18 September 2026.)
        current_live=counts.current_live + counts.kept_under_watch,
        gone_candidates=counts.gone_candidates,
    )
    if reason is not None:
        return reason, [], counts
    return None, events, counts


def events_by_type(events: Iterable[Event]) -> dict[str, int]:
    """The jsonb that goes in scan_runs.events_by_type. Counts, nothing else.

    Every type is present, including the zeros. A missing key and a zero read
    the same to a person skimming a log, and "we found none" is a different
    statement from "we did not look".
    """
    seen = Counter(e.event_type for e in events)
    return {t: seen.get(t, 0) for t in EVENT_TYPES}


def report(counts: DiffCounts, refusal: Optional[str] = None) -> str:
    """Lines of counts for the workflow log. Never a name (M2-DESIGN 7)."""
    if counts.baseline:
        return (
            f"diff: baseline. {counts.current_live:,} live contracts recorded, "
            f"0 events by design — there is nothing yet to compare against"
        )
    head = (
        f"diff: {counts.previous_live:,} live before, {counts.current_live:,} now, "
        f"{counts.matched:,} in both"
    )
    body = (
        f"  events: {counts.expiry_moved:,} expiry moved, "
        f"{counts.value_changed:,} value changed, "
        f"{counts.contract_gone:,} gone early, {counts.new_award:,} new awards"
    )
    quiet = (
        f"  said nothing about: {counts.gone_natural:,} that reached their end date, "
        f"{counts.new_award_withheld:,} new awards to withheld individuals, "
        f"{counts.new_but_amended:,} never-recorded contracts that arrived already amended, "
        f"{counts.new_by_reference:,} never-recorded contracts keyed by reference number, "
        f"{counts.dates_unusable:,} unusable dates, "
        f"{counts.values_unusable:,} unusable values"
    )
    compared = (
        f"  also compared: {counts.returned:,} that came back after an absence, "
        f"{counts.still_published:,} no longer live but still published, "
        f"of which {counts.kept_under_watch:,} kept under watch"
    )
    if refusal:
        return f"{head}\n{body}\n{quiet}\n{compared}\n  REFUSED: {refusal}. Nothing is written."
    return f"{head}\n{body}\n{quiet}\n{compared}"


# --------------------------------------------------------------------------
# Building one event
# --------------------------------------------------------------------------
#
# dedupe_key is "{event_type}|{contract_key or vendor_key}|{before}|{after}",
# M2-DESIGN 5.4, and events_dedupe_unique in 0001_init.sql makes it the thing
# that stops a re-run of the same data inserting anything new. So both halves
# have to be formatted the same way every time: money to two decimal places,
# because the column is numeric(16,2) and 250000.0 and 250000.00 are the same
# amount and would otherwise be two different keys.


def _watch_ref(row: SnapshotRow) -> str:
    """The watch key and the source link: "{org},{ref}". G23."""
    return f"{row.buyer_org_code},{row.reference_number}"


def _dedupe(event_type: str, subject: str, before: str, after: str) -> str:
    return f"{event_type}|{subject}|{before}|{after}"


def _vendor_key_or_none(row: SnapshotRow) -> Optional[str]:
    """A withheld individual's key is the empty string, which is not a key.

    Stored as NULL so that events_vendor_key_idx holds nothing that no watch can
    ever match, and so the feed's supplier query cannot accidentally join every
    withheld contract together on ''.
    """
    return row.vendor_key or None


def _expiry_moved(
    before: SnapshotRow, now: SnapshotRow, old_end: date, new_end: date
) -> Event:
    return Event(
        event_type=EXPIRY_MOVED,
        contract_key=now.contract_key,
        contract_ref=_watch_ref(now),
        vendor_key=_vendor_key_or_none(now),
        dedupe_key=_dedupe(
            EXPIRY_MOVED, now.contract_key, old_end.isoformat(), new_end.isoformat()
        ),
        payload={
            "from": old_end.isoformat(),
            "to": new_end.isoformat(),
            "days_moved": (new_end - old_end).days,
            "ref_before": before.reference_number,
            "ref_after": now.reference_number,
        },
    )


def _value_changed(
    before: SnapshotRow, now: SnapshotRow, old_value: float, new_value: float
) -> Event:
    return Event(
        event_type=VALUE_CHANGED,
        contract_key=now.contract_key,
        contract_ref=_watch_ref(now),
        vendor_key=_vendor_key_or_none(now),
        dedupe_key=_dedupe(
            VALUE_CHANGED, now.contract_key, _money(old_value), _money(new_value)
        ),
        payload={
            "from": _money(old_value),
            "to": _money(new_value),
            "ref_before": before.reference_number,
            "ref_after": now.reference_number,
        },
    )


def _contract_gone(before: SnapshotRow) -> Event:
    end = _as_date(before.end_date)
    value = _as_money(before.contract_value)
    return Event(
        event_type=CONTRACT_GONE,
        contract_key=before.contract_key,
        contract_ref=_watch_ref(before),
        vendor_key=_vendor_key_or_none(before),
        # The "after" half is empty because there is no after: the contract is
        # not there any more. An empty half is honest; inventing a token to fill
        # it would make the key look like it says something it does not.
        dedupe_key=_dedupe(
            CONTRACT_GONE, before.contract_key, end.isoformat() if end else "", ""
        ),
        payload={
            "last_end_date": end.isoformat() if end else None,
            "last_value": _money(value) if value is not None else None,
            "last_ref": before.reference_number,
        },
    )


def _new_award(now: SnapshotRow) -> Event:
    end = _as_date(now.end_date)
    value = _as_money(now.contract_value)
    return Event(
        event_type=NEW_AWARD,
        contract_key=now.contract_key,
        contract_ref=_watch_ref(now),
        vendor_key=_vendor_key_or_none(now),
        dedupe_key=_dedupe(NEW_AWARD, now.contract_key, "", now.reference_number),
        payload={
            "ref": now.reference_number,
            "value": _money(value) if value is not None else None,
            "end_date": end.isoformat() if end else None,
            "category_key": now.category_key,
        },
    )


def _money(value: float) -> str:
    return f"{value:.2f}"


def _as_date(value: Any) -> Optional[date]:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _as_money(value: Any) -> Optional[float]:
    """Cents. A value that cannot be read is None, and None says nothing.

    Never a zero fallback. `or 0.0` would turn "we do not know what this
    contract is worth" into "it changed from nothing to $310,000", which is an
    invented event of exactly the kind M2's exit criterion is about.
    """
    if value is None or value == "":
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None
