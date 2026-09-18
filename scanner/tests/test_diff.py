"""The diff rules. M2-DESIGN section 6.

Every event type gets a case where it fires exactly once and a case where it
does not fire on a snapshot that changed in some way that is not news
(CODING-STANDARDS 7). "Exactly once" is asserted rather than "at least once",
because a rule that fires twice on one change is as wrong as one that never
fires, and a reader would see the same thing said twice.
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta

import diff
import snapshot
from tests import invented
from tests.invented import TODAY, by_key, snapshot_row


def only(events, event_type):
    """The single event of that type, failing loudly on none or several."""
    matching = [e for e in events if e.event_type == event_type]
    if len(matching) != 1:
        raise AssertionError(
            f"expected exactly one {event_type}, got {len(matching)}; "
            f"all types present: {sorted(e.event_type for e in events)}"
        )
    return matching[0]


class ExpiryMoved(unittest.TestCase):
    def test_fires_once_when_the_end_date_moves(self):
        before = [snapshot_row(end_date="2027-03-31")]
        after = [snapshot_row(end_date="2028-03-31", reference="ZZ-TEST-0001-A1")]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(len(events), 1, "the value did not change; only one event is due")
        event = only(events, diff.EXPIRY_MOVED)
        self.assertEqual(event.payload["from"], "2027-03-31")
        self.assertEqual(event.payload["to"], "2028-03-31")
        self.assertEqual(event.payload["days_moved"], 366, "2028 is a leap year")
        self.assertEqual(counts.expiry_moved, 1)

    def test_carries_both_references_so_the_link_points_at_the_amendment(self):
        # An amendment arrives under a NEW reference number. The event has to
        # carry both: ref_after is what the government's record is addressed by
        # now, ref_before is what the reader was watching.
        before = [snapshot_row(reference="ZZ-TEST-0001")]
        after = [snapshot_row(reference="ZZ-TEST-0001-A1", end_date="2028-03-31")]

        event = only(diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)[0], diff.EXPIRY_MOVED)

        self.assertEqual(event.payload["ref_before"], "ZZ-TEST-0001")
        self.assertEqual(event.payload["ref_after"], "ZZ-TEST-0001-A1")
        self.assertEqual(
            event.contract_ref,
            "aa-invented,ZZ-TEST-0001-A1",
            "contract_ref is the reference AS AT the event, which is the new one",
        )

    def test_does_not_fire_when_the_end_date_is_unchanged(self):
        # Everything else about the contract moves. The date does not.
        before = [snapshot_row(end_date="2027-03-31", amendment_count=1)]
        after = [snapshot_row(end_date="2027-03-31", amendment_count=4,
                              reference="ZZ-TEST-0001-A3")]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.matched, 1, "the contract was matched, it just said nothing")

    def test_says_nothing_when_either_date_is_missing(self):
        # A date the source never published is not a date that moved.
        before = [snapshot_row(end_date=None)]
        after = [snapshot_row(end_date="2028-03-31")]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.dates_unusable, 1)


class ValueChanged(unittest.TestCase):
    def test_fires_once_when_the_value_changes(self):
        before = [snapshot_row(value=240_000.0)]
        after = [snapshot_row(value=310_000.0, reference="ZZ-TEST-0001-A1")]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(len(events), 1)
        event = only(events, diff.VALUE_CHANGED)
        self.assertEqual(event.payload["from"], "240000.00")
        self.assertEqual(event.payload["to"], "310000.00")
        self.assertEqual(counts.value_changed, 1)

    def test_does_not_fire_on_a_dollar_or_less(self):
        # A contract's value is amended by a few dollars often enough that
        # reporting it would bury the amendments that matter.
        for delta in (0.0, 0.5, 1.0):
            with self.subTest(delta=delta):
                before = [snapshot_row(value=240_000.0)]
                after = [snapshot_row(value=240_000.0 + delta)]
                events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)
                self.assertEqual(events, [], f"${delta} is inside the tolerance")

    def test_fires_just_past_the_tolerance(self):
        before = [snapshot_row(value=240_000.0)]
        after = [snapshot_row(value=240_001.01)]

        events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(len(events), 1, "the tolerance is more than a dollar, not at least")

    def test_says_nothing_when_either_value_is_missing(self):
        # "from nothing to $310,000" is an invented event, not a value change.
        before = [snapshot_row(value=None)]
        after = [snapshot_row(value=310_000.0)]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.values_unusable, 1)


class ContractGone(unittest.TestCase):
    def test_fires_once_when_a_contract_disappears_before_its_end_date(self):
        before = [snapshot_row(end_date=invented.days(400), value=88_000.0)]

        events, counts = diff.diff(by_key(before), {}, [], invented.published_of([]), TODAY)

        self.assertEqual(len(events), 1)
        event = only(events, diff.CONTRACT_GONE)
        self.assertEqual(event.payload["last_end_date"], invented.days(400))
        self.assertEqual(event.payload["last_value"], "88000.00")
        self.assertEqual(event.payload["last_ref"], "ZZ-TEST-0001")
        self.assertEqual(counts.contract_gone, 1)

    def test_does_not_fire_for_a_contract_that_simply_ended(self):
        # M2-DESIGN 6 rule 3, and the single largest source of invented events:
        # 215 of the 257 contracts that left the data between two real snapshots
        # were this.
        before = [snapshot_row(end_date=invented.days(-1))]

        events, counts = diff.diff(by_key(before), {}, [], invented.published_of([]), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.gone_natural, 1)

    def test_the_boundary_is_the_run_date_itself(self):
        # A contract ending TODAY is still live today. Off by one here turns
        # every contract's last day into a disappearance.
        for offset, should_fire in ((-1, False), (0, True), (1, True)):
            with self.subTest(offset=offset):
                before = [snapshot_row(end_date=invented.days(offset))]
                events, _ = diff.diff(by_key(before), {}, [], invented.published_of([]), TODAY)
                self.assertEqual(len(events), 1 if should_fire else 0)

    def test_says_nothing_when_the_last_end_date_is_unknown(self):
        before = [snapshot_row(end_date=None)]

        events, counts = diff.diff(by_key(before), {}, [], invented.published_of([]), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.dates_unusable, 1)


class ContractsThatLeaveTheLiveSet(unittest.TestCase):
    """"Not live any more" is not "not published any more". Review, 17 Sep.

    The government's dataset is historical and keeps a contract after it ends.
    The first version of diff.py fired CONTRACT_GONE for anything that left the
    LIVE set before its old end date, which included every contract terminated
    early: an amendment pulls the end date into the past, the contract drops
    out of the live set, and the scanner announced "No longer in the published
    data. It was due to end 31 March 2028" about a contract that was published
    right there with its new date. Three of seven review lenses found it
    independently. It is the invented event M2's exit criterion forbids.
    """

    def test_a_termination_is_an_expiry_moved_not_a_disappearance(self):
        before = [snapshot_row(end_date="2028-03-31")]
        # The contract is gone from the live set but still in the download,
        # under its amendment's reference, ending last week.
        published = {
            "aa-invented::PID-0001": snapshot.PublishedFact(
                buyer_org_code="aa-invented",
                reference_number="ZZ-TEST-0001-A1",
                end_date=invented.days(-7),
                contract_value=250_000.0,
            )
        }

        events, counts = diff.diff(by_key(before), {}, [], published, TODAY)

        self.assertEqual(
            [e.event_type for e in events], [diff.EXPIRY_MOVED],
            "a terminated contract was reported as gone from the published data",
        )
        moved = events[0]
        self.assertEqual(moved.payload["from"], "2028-03-31")
        self.assertEqual(moved.payload["to"], invented.days(-7))
        self.assertLess(moved.payload["days_moved"], 0, "the end date came IN")
        self.assertEqual(moved.payload["ref_after"], "ZZ-TEST-0001-A1")
        self.assertEqual(counts.contract_gone, 0)
        self.assertEqual(counts.still_published, 1)

    def test_the_reviewers_reproduction_through_the_real_pipeline(self):
        # The exact shape the review ran, end to end through snapshot.pipeline —
        # normalize, collect_refs, deduplicate, derive_category_names,
        # filter_recompete — so no hand-built row can make it pass.
        snapshot.load_site_rules()
        original = invented.source_row(contract_date="2025-04-01", end_date="2028-03-31")
        termination = invented.source_row(
            contract_date="2026-09-10", end_date=invented.days(-7),
            reference="ZZ-TEST-0001-A1",
        )

        week1 = snapshot.pipeline([original], TODAY)
        before, _ = snapshot.build_snapshot(week1.rows, TODAY)

        # Both orders. The download is paged by offset with no sort, so the
        # amendment can come first; ingest.deduplicate picks by contract_date
        # precisely because order is not trusted, and `published` must be built
        # from its result. In date order, "last row wins" and "latest amendment
        # wins" give the same answer, which is how the first version of this
        # case passed with `published` built from the wrong rows. Review, R2-11.
        for label, rows in (("in date order", [original, termination]),
                            ("amendment first", [termination, original])):
            with self.subTest(order=label):
                week2 = snapshot.pipeline(rows, TODAY)
                after, _ = snapshot.build_snapshot(week2.rows, TODAY)

                self.assertEqual(after, [], "the premise: it has left the live set")
                self.assertIn("aa-invented::PID-0001", week2.published)

                events, _ = diff.diff(by_key(before), {}, after, week2.published, TODAY)

                # Pinned exactly. "days_moved < 0" alone passes for ANY past
                # date, including a wrong one taken from the wrong field.
                self.assertEqual([e.event_type for e in events], [diff.EXPIRY_MOVED])
                self.assertEqual(events[0].payload["from"], "2028-03-31")
                self.assertEqual(events[0].payload["to"], invented.days(-7))
                self.assertEqual(events[0].payload["ref_after"], "ZZ-TEST-0001-A1")
                self.assertEqual(events[0].contract_ref, "aa-invented,ZZ-TEST-0001-A1")

    def test_a_natural_ending_through_the_real_pipeline_says_nothing(self):
        # The ordinary departure — 215 of 257 in the design's measurement —
        # through pipeline() rather than published_of, so a PublishedFact built
        # from the wrong field (the start date, say) would invent an
        # EXPIRY_MOVED for every contract that simply ends. Review, R2-11.
        snapshot.load_site_rules()
        row = invented.source_row(contract_date="2025-04-01", end_date="2026-09-20",
                                  value=180_000.0, original_value=100_000.0)
        before_day, after_day = date(2026, 9, 14), date(2026, 9, 28)

        week1 = snapshot.pipeline([row], before_day)
        before, _ = snapshot.build_snapshot(week1.rows, before_day)
        week2 = snapshot.pipeline([row], after_day)
        after, _ = snapshot.build_snapshot(week2.rows, after_day)

        self.assertEqual(len(before), 1)
        self.assertEqual(after, [])
        events, counts = diff.diff(by_key(before), {}, after, week2.published, after_day)

        self.assertEqual(events, [], "a contract that simply ended produced an event")
        self.assertEqual(counts.still_published, 1)

    def test_a_contract_that_simply_ended_and_is_still_published_says_nothing(self):
        # The ordinary case on real data: it reached its end date, the
        # government still publishes it, nothing about it changed.
        before = [snapshot_row(end_date=invented.days(-1))]

        events, counts = diff.diff(
            by_key(before), {}, [], invented.published_of(before), TODAY
        )

        self.assertEqual(events, [])
        self.assertEqual(counts.contract_gone, 0)
        self.assertEqual(counts.still_published, 1)

    def test_a_contract_truly_withdrawn_from_the_data_is_still_gone(self):
        # The fix must not switch CONTRACT_GONE off. A contract missing from
        # the download altogether, before its end date, is exactly what the
        # event exists for.
        before = [snapshot_row(end_date=invented.days(400))]

        events, _ = diff.diff(by_key(before), {}, [], {}, TODAY)

        self.assertEqual([e.event_type for e in events], [diff.CONTRACT_GONE])

    def test_a_terminated_contracts_supplier_comes_from_the_suppressed_row(self):
        # PublishedFact carries no supplier at all. The event's key must come
        # from the previous snapshot row, which went through suppression — so a
        # withheld individual's terminated contract still carries no key.
        before = [snapshot_row(end_date="2028-03-31", vendor_key="",
                               vendor_display="Individual supplier (name withheld)")]
        published = {
            "aa-invented::PID-0001": snapshot.PublishedFact(
                "aa-invented", "ZZ-TEST-0001-A1", invented.days(-7), 250_000.0
            )
        }

        events, _ = diff.diff(by_key(before), {}, [], published, TODAY)

        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0].vendor_key)

    def test_a_still_published_contract_with_no_reference_says_nothing(self):
        # An event needs a reference to link to. Without one it cannot be
        # checked against the government's record, so it is not emitted.
        before = [snapshot_row(end_date="2028-03-31")]
        published = {
            "aa-invented::PID-0001": snapshot.PublishedFact(
                "aa-invented", "", invented.days(-7), 250_000.0
            )
        }

        events, counts = diff.diff(by_key(before), {}, [], published, TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.contract_gone, 0, "published is published, reference or not")


class WhatGetsRecorded(unittest.TestCase):
    """rows_to_record: what contract_snapshot must hold for next week to be true.

    Every case in this file checks one run. These check that one run leaves the
    database in a state where the NEXT run tells the truth, which no single-run
    case can see.
    """

    K = "aa-invented::PID-0001"

    def test_terminated_then_reinstated_reports_each_move_from_where_it_really_was(self):
        # Measured before this function existed: run 3 said the date moved from
        # 2027-03-31, contradicting run 2, which had said it moved to
        # 2026-09-10. The government record reads 2027 -> 2026 -> 2028.
        week1 = snapshot_row(contract_key=self.K, end_date="2027-03-31")
        recorded = {self.K: week1}

        # Run 2: terminated. Not live; still published, ending 2026-09-10.
        published2 = {
            self.K: snapshot.PublishedFact(
                "aa-invented", "ZZ-TEST-0001-A1", "2026-09-10", 250_000.0
            )
        }
        events2, _ = diff.diff({self.K: week1}, recorded, [], published2, TODAY)
        self.assertEqual(
            [(e.payload["from"], e.payload["to"]) for e in events2],
            [("2027-03-31", "2026-09-10")],
        )
        record2 = diff.rows_to_record({self.K: week1}, recorded, [], published2, run_date=TODAY)
        recorded = {**recorded, **{r.contract_key: r for r in record2.live + record2.refreshed}}

        # Run 3: reinstated. Live again, ending 2028-03-31.
        now3 = [snapshot_row(contract_key=self.K, end_date="2028-03-31",
                             reference="ZZ-TEST-0001-A2")]
        events3, _ = diff.diff(
            {}, recorded, now3, invented.published_of(now3), TODAY + timedelta(days=14)
        )

        self.assertEqual(
            [(e.payload["from"], e.payload["to"]) for e in events3],
            [("2026-09-10", "2028-03-31")],
            "run 3 must move FROM where run 2 left it, or the two events contradict",
        )

    def test_the_live_rows_are_recorded_as_they_are(self):
        now = [snapshot_row(contract_key=self.K)]
        record = diff.rows_to_record({}, {}, now, invented.published_of(now), run_date=TODAY)
        self.assertEqual(record.live, now)
        self.assertEqual(record.refreshed, [])

    def test_a_contract_that_ended_unchanged_is_not_rewritten(self):
        # Most departures. Rewriting a row that has not changed is a write for
        # nothing, and "refreshed" would stop meaning "something changed".
        ended = snapshot_row(contract_key=self.K, end_date=invented.days(-3))
        record = diff.rows_to_record(
            {self.K: ended}, {}, [], invented.published_of([ended]), run_date=TODAY
        )
        self.assertEqual(record.refreshed, [])

    def test_a_lapsed_contract_amended_while_not_live_is_left_for_its_return(self):
        # Lapsed before last week, so not in previous_live, and amended while
        # still not live. No event now: a lapsed contract's paperwork moving is
        # not news. And NOT refreshed: nothing has accounted for the move, so
        # it must still be there to compare against when the contract comes
        # back. The first version of this case asserted the opposite — that the
        # row WAS refreshed — and so pinned the fault in place: round two of the
        # review showed the refresh absorbed the change, and the next event then
        # started from a figure no event had ever shown.
        lapsed = snapshot_row(contract_key=self.K, end_date=invented.days(-60),
                              value=250_000.0)
        published = {
            self.K: snapshot.PublishedFact(
                "aa-invented", "ZZ-TEST-0001-A3", invented.days(-45), 260_000.0
            )
        }

        events, _ = diff.diff({}, {self.K: lapsed}, [], published, TODAY)
        record = diff.rows_to_record({}, {self.K: lapsed}, [], published, run_date=TODAY)

        self.assertEqual(events, [], "no event for a contract that was not live either week")
        self.assertEqual(record.refreshed, [], "the move was absorbed with no event to show it")

    def test_a_contract_missing_from_the_download_keeps_its_last_good_row(self):
        # Nothing trustworthy to put in its place. A withdrawn contract's row
        # stands as it was, so a watch on it still resolves (M2-DESIGN 5.1).
        gone = snapshot_row(contract_key=self.K, end_date=invented.days(400))
        record = diff.rows_to_record({self.K: gone}, {}, [], {}, run_date=TODAY)
        self.assertEqual(record.refreshed, [])

    def test_a_withdrawn_contract_that_comes_back_is_recorded_as_live_again(self):
        # Round two of the review, 17 September. Withdrawn for one run (a true
        # CONTRACT_GONE), then back in the download unchanged. No event is
        # emitted for the return — M2-DESIGN defines no event for it — so the
        # feed's newest event would still read "No longer in the published
        # data" about a contract that is. That is a DISPLAY question and it is
        # PR E's (MILESTONES, PR E). What PR B owes it is that the return is
        # RECORDED rather than discarded: the contract is in Record.live, so the
        # writer moves its last_seen_run past the CONTRACT_GONE's scan_run_id,
        # and the feed can tell the event is no longer current.
        row = snapshot_row(contract_key=self.K, end_date="2028-03-31")

        events, counts = diff.diff(
            {}, {self.K: row}, [row], invented.published_of([row]), TODAY
        )
        record = diff.rows_to_record({}, {self.K: row}, [row], invented.published_of([row]), run_date=TODAY)

        self.assertEqual(events, [], "unchanged, so nothing to say")
        self.assertEqual(counts.returned, 1)
        self.assertEqual([r.contract_key for r in record.live], [self.K],
                         "the return must be recorded, or the feed cannot know it happened")

    def test_a_refreshed_row_keeps_the_suppressed_supplier(self):
        # PublishedFact carries no supplier, so the refreshed row's supplier
        # can only be the one the recorded row already had — post-suppression.
        withheld = snapshot_row(contract_key=self.K, end_date="2027-03-31", vendor_key="",
                                vendor_display="Individual supplier (name withheld)")
        published = {
            self.K: snapshot.PublishedFact("aa-invented", "ZZ-TEST-0001-A1", "2026-09-10", 1.0)
        }
        record = diff.rows_to_record({self.K: withheld}, {}, [], published, run_date=TODAY)

        self.assertEqual(record.refreshed[0].vendor_key, "")
        self.assertEqual(record.refreshed[0].vendor_display, "Individual supplier (name withheld)")


class NewAward(unittest.TestCase):
    def test_fires_once_for_a_contract_never_seen_before(self):
        after = [snapshot_row(contract_key="aa-invented::PID-9999", value=85_000.0,
                              end_date="2027-06-30")]

        events, counts = diff.diff({}, {}, after, invented.published_of(after), TODAY)

        self.assertEqual(len(events), 1)
        event = only(events, diff.NEW_AWARD)
        self.assertEqual(event.payload["value"], "85000.00")
        self.assertEqual(event.payload["end_date"], "2027-06-30")
        self.assertEqual(event.vendor_key, "northwind widgets")
        self.assertEqual(counts.new_award, 1)

    def test_does_not_fire_for_a_contract_seen_in_an_earlier_run(self):
        # It is not in the previous run's live set, but contract_snapshot has
        # held it before, so it is not new. Unchanged since it was last recorded,
        # so there is nothing else to say either.
        key = "aa-invented::PID-9999"
        last_recorded = snapshot_row(contract_key=key)
        after = [snapshot_row(contract_key=key)]

        events, counts = diff.diff(
            {}, {key: last_recorded}, after, invented.published_of(after), TODAY
        )

        self.assertEqual(events, [])
        self.assertEqual(counts.returned, 1)
        self.assertEqual(counts.new_award, 0)


class ContractsThatComeBack(unittest.TestCase):
    """A contract absent last run and present now. Adversarial review, 17 Sep.

    The first version said nothing at all about these, on the reasoning that
    there was "no previous state to say what moved". There is: contract_snapshot
    keeps the last row it recorded for every contract (M2-DESIGN 5.1). Saying
    nothing lost the change permanently, because the next run compares against
    the new values and the move is then invisible for ever.
    """

    def test_a_change_made_while_it_was_away_is_reported_against_what_was_recorded(self):
        key = "aa-invented::PID-0001"
        last_recorded = snapshot_row(contract_key=key, end_date="2027-03-31", value=240_000.0)
        back = [snapshot_row(contract_key=key, end_date="2028-03-31", value=310_000.0,
                             reference="ZZ-TEST-0001-A1")]

        events, counts = diff.diff(
            {}, {key: last_recorded}, back, invented.published_of(back), TODAY
        )

        self.assertEqual(counts.returned, 1)
        self.assertEqual(only(events, diff.EXPIRY_MOVED).payload["from"], "2027-03-31")
        self.assertEqual(only(events, diff.VALUE_CHANGED).payload["from"], "240000.00")
        self.assertEqual(counts.new_award, 0, "it has been seen before; it is not new")

    def test_last_weeks_row_wins_over_an_older_one_for_the_same_contract(self):
        # previous_live and ever_seen can both hold a row for one contract. In
        # the database they are the same row, updated in place, but diff.py is
        # not told that and must not depend on it: if the older row won, a
        # contract that has not changed since last week would be compared
        # against how it looked last year, and an event would be invented out of
        # a change that was already reported.
        key = "aa-invented::PID-0001"
        last_week = snapshot_row(contract_key=key, end_date="2027-03-31")
        last_year = snapshot_row(contract_key=key, end_date="2020-03-31")
        now = [snapshot_row(contract_key=key, end_date="2027-03-31")]

        events, counts = diff.diff(
            {key: last_week}, {key: last_year}, now, invented.published_of(now), TODAY
        )

        self.assertEqual(events, [], "compared against the stale row, not last week's")
        self.assertEqual(counts.matched, 1)
        self.assertEqual(counts.returned, 0)

    def test_an_option_year_taken_up_after_the_contract_lapsed(self):
        # The event a recompete watcher most needs. The contract reached its end
        # date and left the live set; weeks later an amendment exercises an
        # option year and it is live again with a new end date. The last state
        # recorded for it is the lapsed one.
        key = "aa-invented::PID-0001"
        lapsed = snapshot_row(contract_key=key, end_date=invented.days(-20))
        renewed = [snapshot_row(contract_key=key, end_date=invented.days(345),
                                reference="ZZ-TEST-0001-A2")]

        events, _ = diff.diff(
            {}, {key: lapsed}, renewed, invented.published_of(renewed), TODAY
        )

        moved = only(events, diff.EXPIRY_MOVED)
        self.assertEqual(moved.payload["days_moved"], 365)
        self.assertEqual(moved.payload["ref_after"], "ZZ-TEST-0001-A2")

    def test_does_not_fire_for_a_withheld_individual(self):
        # M2-DESIGN 6 rule 4. The snapshot row is still written — the contract
        # counts towards every total — but the only people a NEW_AWARD could
        # reach are supplier watchers, and a withheld individual has no
        # watchable key for anybody to have followed.
        after = [
            snapshot_row(
                contract_key="aa-invented::PID-9999",
                vendor_key="",
                vendor_display="Individual supplier (name withheld)",
            )
        ]

        events, counts = diff.diff({}, {}, after, invented.published_of(after), TODAY)

        self.assertEqual(events, [])
        self.assertEqual(counts.new_award_withheld, 1)

    def test_does_not_fire_for_a_contract_that_was_live_last_run(self):
        row = snapshot_row()
        events, _ = diff.diff(by_key([row]), {}, [row], invented.published_of([row]), TODAY)
        self.assertEqual(events, [])


class OneAmendmentTwoEvents(unittest.TestCase):
    def test_a_date_and_a_value_moving_together_are_two_events(self):
        # M2-DESIGN 6 rule 5. They are two facts and a reader may care about
        # either. Both carry the same ref_after, because one amendment produced
        # both.
        before = [snapshot_row(end_date="2027-03-31", value=240_000.0,
                               reference="ZZ-TEST-0001")]
        after = [snapshot_row(end_date="2028-03-31", value=310_000.0,
                              reference="ZZ-TEST-0001-A1")]

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(len(events), 2)
        moved = only(events, diff.EXPIRY_MOVED)
        changed = only(events, diff.VALUE_CHANGED)
        self.assertEqual(moved.payload["ref_after"], "ZZ-TEST-0001-A1")
        self.assertEqual(changed.payload["ref_after"], "ZZ-TEST-0001-A1")
        self.assertEqual(moved.contract_key, changed.contract_key)
        self.assertNotEqual(
            moved.dedupe_key, changed.dedupe_key, "two events need two dedupe keys"
        )
        self.assertEqual(counts.total_events, 2)


class TheFirstRun(unittest.TestCase):
    def test_a_baseline_emits_nothing_at_all(self):
        # M2-DESIGN 6 rule 1. Without this every one of 25,000 live contracts
        # arrives as a NEW_AWARD on the day tracking starts.
        current = [snapshot_row(contract_key=f"aa-invented::PID-{n:04d}") for n in range(50)]

        events, counts = diff.diff({}, {}, current, invented.published_of(current), TODAY, is_baseline=True)

        self.assertEqual(events, [])
        self.assertTrue(counts.baseline)
        self.assertEqual(counts.current_live, 50, "the contracts are still recorded")

    def test_a_baseline_emits_nothing_even_when_there_is_a_previous_snapshot(self):
        # A baseline is a statement about this run, not about the data. If a
        # baseline is ever re-run deliberately, it must still say nothing.
        before = [snapshot_row(end_date="2027-03-31")]
        after = [snapshot_row(end_date="2028-03-31")]

        events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY, is_baseline=True)

        self.assertEqual(events, [])


class FrozenDayCounts(unittest.TestCase):
    """The fault that shaped the whole design. M2-DESIGN 2.2."""

    def test_every_row_having_a_different_days_to_expiry_emits_nothing(self):
        # Two runs a fortnight apart over IDENTICAL source data. ingest computes
        # days_to_expiry against the day it runs, so every row's differs by
        # exactly 14 — which is what was measured on two real snapshots, on all
        # 25,042 matched contracts. Not one end date moved. A scanner comparing
        # day counts would report 25,042 changes and hide everything real.
        raws = [
            invented.source_row(
                procurement_id=f"PID-{n:04d}",
                reference=f"ZZ-TEST-{n:04d}",
                end_date=invented.days(400 + n),
            )
            for n in range(40)
        ]
        first_day = TODAY
        second_day = TODAY + timedelta(days=14)

        rows_a = invented.pipeline_rows(raws, today=first_day)
        rows_b = invented.pipeline_rows(raws, today=second_day)

        # The premise of the test: the day counts really did all move.
        deltas = {
            b["days_to_expiry"] - a["days_to_expiry"]
            for a, b in zip(rows_a, rows_b)
        }
        self.assertEqual(deltas, {-14}, "the fixture must reproduce the frozen day count")

        before, _ = snapshot.build_snapshot(rows_a, first_day)
        after, _ = snapshot.build_snapshot(rows_b, second_day)
        self.assertEqual(len(before), 40)

        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), second_day)

        self.assertEqual(events, [], "a day count moving is not a contract changing")
        self.assertEqual(counts.matched, 40)


class Refusals(unittest.TestCase):
    """M2-DESIGN 6.6. Each rule refuses, and a refused run writes nothing."""

    def test_a_failed_self_test_refuses(self):
        self.assertEqual(
            diff.refusal_reason(
                self_tests_passed=False, drift_passed=True,
                previous_live=100, current_live=100, gone_candidates=0,
            ),
            diff.REFUSAL_SELF_TEST,
        )

    def test_a_failed_drift_check_refuses(self):
        self.assertEqual(
            diff.refusal_reason(
                self_tests_passed=True, drift_passed=False,
                previous_live=100, current_live=100, gone_candidates=0,
            ),
            diff.REFUSAL_DRIFT,
        )

    def test_live_contracts_falling_by_more_than_a_tenth_refuses(self):
        self.assertIsNone(
            diff.refusal_reason(
                self_tests_passed=True, drift_passed=True,
                previous_live=1000, current_live=900, gone_candidates=0,
            ),
            "exactly ten per cent is inside the limit",
        )
        self.assertEqual(
            diff.refusal_reason(
                self_tests_passed=True, drift_passed=True,
                previous_live=1000, current_live=899, gone_candidates=0,
            ),
            diff.REFUSAL_LIVE_COUNT_DROP,
        )

    def test_more_than_a_twentieth_going_at_once_refuses(self):
        self.assertIsNone(
            diff.refusal_reason(
                self_tests_passed=True, drift_passed=True,
                previous_live=1000, current_live=1000, gone_candidates=50,
            ),
            "exactly five per cent is inside the limit",
        )
        self.assertEqual(
            diff.refusal_reason(
                self_tests_passed=True, drift_passed=True,
                previous_live=1000, current_live=1000, gone_candidates=51,
            ),
            diff.REFUSAL_GONE_RATE,
        )

    def test_neither_data_rule_can_fire_on_the_first_run(self):
        # A percentage of no previous contracts is not a small number, it is not
        # a number. Letting these fire on a baseline would refuse every first
        # run there will ever be.
        #
        # The third case is the one that does the work, and it took the break
        # harness to find that out. With previous_live at zero, `current_live <
        # 0 * 0.9` is false whatever current_live is, so relaxing the guard from
        # `> 0` to `>= 0` changed no answer the first two cases look at and the
        # case passed on broken code. `gone_candidates > 0 * 0.05` is a
        # different matter: it becomes `gone > 0`, and any figure at all refuses.
        for previous, current, gone in ((0, 0, 0), (0, 25_000, 0), (0, 0, 1)):
            with self.subTest(previous=previous, current=current, gone=gone):
                self.assertIsNone(
                    diff.refusal_reason(
                        self_tests_passed=True, drift_passed=True,
                        previous_live=previous, current_live=current,
                        gone_candidates=gone,
                    )
                )

    def test_a_refused_run_hands_back_no_events_to_write(self):
        # The refusal is not advice. run_diff returns an empty list, so a caller
        # that ignored the reason still has nothing it could publish.
        before = {
            f"aa-invented::PID-{n:04d}": snapshot_row(
                contract_key=f"aa-invented::PID-{n:04d}",
                reference=f"ZZ-TEST-{n:04d}",
                end_date=invented.days(400),
            )
            for n in range(100)
        }
        after = [before[f"aa-invented::PID-{n:04d}"] for n in range(80)]

        reason, events, counts = diff.run_diff(before, {}, after, invented.published_of(after), TODAY)

        self.assertEqual(reason, diff.REFUSAL_LIVE_COUNT_DROP)
        self.assertEqual(events, [])
        self.assertEqual(
            counts.contract_gone, 20,
            "the counts survive the refusal; they are what the thresholds get tuned from",
        )

    def test_a_healthy_run_is_not_refused(self):
        before = {
            f"aa-invented::PID-{n:04d}": snapshot_row(
                contract_key=f"aa-invented::PID-{n:04d}",
                reference=f"ZZ-TEST-{n:04d}",
            )
            for n in range(100)
        }
        after = list(before.values())

        reason, events, _ = diff.run_diff(before, {}, after, invented.published_of(after), TODAY)

        self.assertIsNone(reason)
        self.assertEqual(events, [])

    def test_the_four_codes_are_the_four_the_database_accepts(self):
        # migration 0004's scan_runs_refusal_reason_check lists exactly these.
        # Pinned here so the two cannot drift apart without a failure.
        self.assertEqual(
            sorted(
                [
                    diff.REFUSAL_LIVE_COUNT_DROP,
                    diff.REFUSAL_GONE_RATE,
                    diff.REFUSAL_DRIFT,
                    diff.REFUSAL_SELF_TEST,
                ]
            ),
            ["drift", "gone_rate", "live_count_drop", "self_test"],
        )


class DedupeKeys(unittest.TestCase):
    def test_the_same_data_twice_produces_the_same_keys(self):
        # events_dedupe_unique is what stops a re-run inserting anything new, so
        # the key has to be a function of the data and of nothing else.
        before = [snapshot_row(end_date="2027-03-31", value=240_000.0)]
        after = [snapshot_row(end_date="2028-03-31", value=310_000.0)]

        first, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)
        second, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY + timedelta(days=7))

        self.assertEqual(
            [e.dedupe_key for e in first],
            [e.dedupe_key for e in second],
            "the run date must not be part of the key, or every week re-reports everything",
        )

        # And the exact strings, because the comparison above only proves the
        # two calls agree with each other. A key built from today's clock, or
        # from a counter, agrees with itself inside one run and changes by the
        # next one — which is the fault that would re-report every event every
        # week and would be invisible until the second Monday. Found by the
        # break harness, which injected exactly that and was not caught.
        self.assertEqual(
            sorted(e.dedupe_key for e in first),
            [
                "EXPIRY_MOVED|aa-invented::PID-0001|2027-03-31|2028-03-31",
                "VALUE_CHANGED|aa-invented::PID-0001|240000.00|310000.00",
            ],
        )

    def test_the_key_of_every_type_is_pinned(self):
        # The four shapes, written out. M2-DESIGN 5.4 gives the format as
        # "{event_type}|{contract_key or vendor_key}|{before}|{after}", and this
        # is the only place that says what before and after are for each type.
        gone_row = snapshot_row(
            contract_key="aa-invented::PID-0002", reference="ZZ-TEST-0002",
            end_date=invented.days(400),
        )
        new_row = snapshot_row(
            contract_key="aa-invented::PID-0003", reference="ZZ-TEST-0003",
        )
        events, _ = diff.diff(
            by_key([snapshot_row(end_date="2027-03-31", value=240_000.0), gone_row]),
            {},
            [snapshot_row(end_date="2028-03-31", value=310_000.0), new_row], invented.published_of([snapshot_row(end_date="2028-03-31", value=310_000.0), new_row]),
            TODAY,
        )
        keys = {e.event_type: e.dedupe_key for e in events}

        self.assertEqual(
            keys[diff.EXPIRY_MOVED],
            "EXPIRY_MOVED|aa-invented::PID-0001|2027-03-31|2028-03-31",
        )
        self.assertEqual(
            keys[diff.VALUE_CHANGED],
            "VALUE_CHANGED|aa-invented::PID-0001|240000.00|310000.00",
        )
        self.assertEqual(
            keys[diff.CONTRACT_GONE],
            f"CONTRACT_GONE|aa-invented::PID-0002|{invented.days(400)}|",
            "the after half is empty because there is no after",
        )
        self.assertEqual(
            keys[diff.NEW_AWARD],
            "NEW_AWARD|aa-invented::PID-0003||ZZ-TEST-0003",
            "the before half is empty because nothing preceded it",
        )

    def test_money_is_formatted_the_same_way_however_it_arrives(self):
        a, _ = diff.diff(
            by_key([snapshot_row(value=240_000)]), {}, [snapshot_row(value=310_000)], invented.published_of([snapshot_row(value=310_000)]), TODAY
        )
        b, _ = diff.diff(
            by_key([snapshot_row(value=240_000.0)]), {}, [snapshot_row(value=310_000.00)], invented.published_of([snapshot_row(value=310_000.00)]),
            TODAY,
        )
        self.assertEqual(a[0].dedupe_key, b[0].dedupe_key)
        self.assertIn("240000.00", a[0].dedupe_key)

    def test_every_event_has_a_subject_the_database_will_accept(self):
        # events_has_subject in 0001_init.sql: contract_ref or vendor_key must
        # be present. An event with neither cannot be inserted at all.
        before = [snapshot_row(end_date="2027-03-31")]
        after = [snapshot_row(end_date="2028-03-31")]
        gone = [snapshot_row(contract_key="aa-invented::PID-0002",
                             reference="ZZ-TEST-0002", end_date=invented.days(400))]
        new = [snapshot_row(contract_key="aa-invented::PID-0003",
                            reference="ZZ-TEST-0003")]

        events, _ = diff.diff(by_key(before + gone), {}, after + new, invented.published_of(after + new), TODAY)

        self.assertEqual(len(events), 3)
        for event in events:
            with self.subTest(event=event.event_type):
                self.assertTrue(event.contract_ref or event.vendor_key)

    def test_a_withheld_individuals_key_is_stored_as_nothing_not_as_empty(self):
        # '' is not a key. Stored as NULL so the index holds nothing no watch
        # can match, and so the feed cannot join every withheld contract
        # together on the empty string.
        before = [snapshot_row(vendor_key="", vendor_display="Individual supplier (name withheld)",
                               end_date="2027-03-31")]
        after = [snapshot_row(vendor_key="", vendor_display="Individual supplier (name withheld)",
                              end_date="2028-03-31")]

        event = only(diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)[0], diff.EXPIRY_MOVED)

        self.assertIsNone(event.vendor_key)


class EventsByType(unittest.TestCase):
    def test_every_type_is_present_including_the_zeros(self):
        # A missing key and a zero read the same to a person skimming a log, and
        # "we found none" is a different statement from "we did not look".
        counts = diff.events_by_type([])
        self.assertEqual(sorted(counts), sorted(diff.EVENT_TYPES))
        self.assertEqual(set(counts.values()), {0})

    def test_it_counts_what_was_emitted(self):
        before = [snapshot_row(end_date="2027-03-31", value=240_000.0)]
        after = [snapshot_row(end_date="2028-03-31", value=310_000.0)]
        events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)

        self.assertEqual(
            diff.events_by_type(events),
            {"EXPIRY_MOVED": 1, "VALUE_CHANGED": 1, "CONTRACT_GONE": 0, "NEW_AWARD": 0},
        )


class ANameTheRulesNowWithhold(unittest.TestCase):
    """A stored row suppressed under older rules. Late round one #5; R2-3, R2-10.

    Every row in contract_snapshot was judged by the rules in force the week it
    was written. When the site widens them — site PR #19 did, in September — a
    stored row can hold a name the rules now withhold. Each case builds that row
    directly: the name DANA QUILLERAN with a key, as if an older rule had let it
    through. Today's rules withhold it. Nothing that leaves diff.py may carry it.
    """

    NAME, KEY = "DANA QUILLERAN", "dana quilleran"

    def setUp(self):
        snapshot.load_site_rules()
        from vendor import names
        self.assertTrue(names.is_individual(self.NAME), "the premise: today's rules withhold it")

    def stored(self, **over):
        return snapshot_row(vendor_key=self.KEY, vendor_display=self.NAME, **over)

    def assert_no_name(self, events, rows=()):
        text = " ".join(
            f"{e.vendor_key} {e.contract_ref} {e.dedupe_key} {e.payload}" for e in events
        ) + " ".join(f"{r.vendor_key} {r.vendor_display}" for r in rows)
        self.assertNotIn("QUILLERAN", text.upper())

    def test_a_contract_withdrawn_early_goes_with_no_name(self):
        before = self.stored(end_date=invented.days(400))
        events, _ = diff.diff({before.contract_key: before}, {}, [], {}, TODAY)
        self.assertEqual([e.event_type for e in events], [diff.CONTRACT_GONE])
        self.assertIsNone(events[0].vendor_key)
        self.assert_no_name(events)

    def test_a_terminated_contract_moves_with_no_name(self):
        before = self.stored(end_date="2028-03-31")
        published = {before.contract_key: snapshot.PublishedFact(
            "aa-invented", "ZZ-TEST-0001-A1", invented.days(-7), 250_000.0)}
        events, _ = diff.diff({before.contract_key: before}, {}, [], published, TODAY)
        self.assertEqual([e.event_type for e in events], [diff.EXPIRY_MOVED])
        self.assertIsNone(events[0].vendor_key)
        self.assert_no_name(events)

    def test_the_row_written_back_for_it_is_withheld(self):
        before = self.stored(end_date="2028-03-31")
        published = {before.contract_key: snapshot.PublishedFact(
            "aa-invented", "ZZ-TEST-0001-A1", invented.days(-7), 250_000.0)}
        record = diff.rows_to_record({before.contract_key: before}, {}, [], published, run_date=TODAY)
        self.assertEqual(len(record.refreshed), 1)
        self.assertEqual(record.refreshed[0].vendor_key, "")
        self.assertEqual(record.refreshed[0].vendor_display, "Individual supplier (name withheld)")

    def test_a_contract_that_will_never_be_live_again_is_still_scrubbed(self):
        # Not live now, not live last week, nothing published changed. Only
        # the supplier is rewritten; the facts stay as they were, so no change
        # is absorbed (see test_a_lapsed_contract_amended_while_not_live_...).
        #
        # The download DOES say something new about it: without that, "the
        # facts stay as they were" could not fail. Round three, 18 September
        # 2026, found this case passed an empty download, so absorbing the
        # change while scrubbing passed every test.
        lapsed = self.stored(end_date=invented.days(-400), value=90_000.0)
        published = {lapsed.contract_key: snapshot.PublishedFact(
            "aa-invented", "ZZ-TEST-0001-A3", invented.days(-300), 260_000.0)}
        record = diff.rows_to_record({}, {lapsed.contract_key: lapsed}, [], published,
                                     run_date=TODAY)
        self.assertEqual(len(record.refreshed), 1)
        scrubbed = record.refreshed[0]
        self.assertEqual((scrubbed.vendor_key, scrubbed.vendor_display),
                         ("", "Individual supplier (name withheld)"))
        self.assertEqual((scrubbed.end_date, scrubbed.contract_value, scrubbed.reference_number),
                         (lapsed.end_date, lapsed.contract_value, lapsed.reference_number))

    def test_a_company_is_left_alone(self):
        company = snapshot_row(end_date=invented.days(-400))
        record = diff.rows_to_record({}, {company.contract_key: company}, [], {}, run_date=TODAY)
        self.assertEqual(record.refreshed, [])


class EveryEventCanBeWrittenAndLinked(unittest.TestCase):
    """Late round one #12 and #17: a withheld individual's events."""

    WITHHELD = "Individual supplier (name withheld)"

    def withheld(self, **over):
        return snapshot_row(vendor_key="", vendor_display=self.WITHHELD, **over)

    def test_each_event_type_carries_its_own_link_and_no_key(self):
        # vendor_key is None for all of these, so events_has_subject in 0001
        # rests entirely on contract_ref. The first version of this check used
        # named suppliers only, so the key half always satisfied it and
        # contract_ref was never tested.
        cases = {
            diff.EXPIRY_MOVED: ([self.withheld(end_date="2027-03-31")],
                                [self.withheld(end_date="2028-03-31", reference="ZZ-TEST-0001-A1")]),
            diff.VALUE_CHANGED: ([self.withheld(value=240_000.0)],
                                 [self.withheld(value=310_000.0, reference="ZZ-TEST-0001-A1")]),
            diff.CONTRACT_GONE: ([self.withheld(end_date=invented.days(400))], []),
        }
        for event_type, (before, after) in cases.items():
            with self.subTest(event_type=event_type):
                events, _ = diff.diff(by_key(before), {}, after,
                                      invented.published_of(after), TODAY)
                event = only(events, event_type)
                ref = after[0].reference_number if after else before[0].reference_number
                self.assertEqual(event.contract_ref, f"aa-invented,{ref}")
                self.assertIsNone(event.vendor_key, "'' would join every withheld contract together")


class NothingFromAMissingValue(unittest.TestCase):
    """Late round one #13: the NEW side missing, not only the old one."""

    def test_a_value_that_disappears_is_not_a_change_to_zero(self):
        events, counts = diff.diff(by_key([snapshot_row(value=240_000.0)]), {},
                                   [snapshot_row(value=None)],
                                   invented.published_of([snapshot_row(value=None)]), TODAY)
        self.assertEqual(events, [], "'changed to $0.00' is an invented event")
        self.assertEqual(counts.values_unusable, 1)

    def test_a_date_that_disappears_is_not_a_move(self):
        before = [snapshot_row(end_date="2027-03-31")]
        after = [snapshot_row(end_date=None)]
        events, counts = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY)
        self.assertEqual(events, [])
        self.assertEqual(counts.dates_unusable, 1)


class RefusalsThroughRunDiff(unittest.TestCase):
    """Late round one #11: the rules exercised through run_diff, not beside it."""

    def fleet(self, n, **over):
        return {f"aa-invented::PID-{i:04d}": snapshot_row(
            contract_key=f"aa-invented::PID-{i:04d}", reference=f"ZZ-TEST-{i:04d}",
            end_date=invented.days(400), **over) for i in range(n)}

    def test_six_in_a_hundred_withdrawn_with_the_live_count_flat_is_refused(self):
        # The case the other refusal test could not reach: the live count holds
        # steady because a new quarter landed, so live_count_drop stays quiet
        # and only the gone rate can stop six invented CONTRACT_GONEs.
        before = self.fleet(100)
        kept = [r for k, r in before.items() if int(k[-4:]) >= 6]
        newcomers = [snapshot_row(contract_key=f"aa-invented::PID-9{i:03d}",
                                  reference=f"ZZ-TEST-9{i:03d}") for i in range(6)]
        after = kept + newcomers
        self.assertEqual(len(after), 100, "the premise: the live count is flat")

        reason, events, counts = diff.run_diff(before, {}, after,
                                               invented.published_of(after), TODAY)

        self.assertEqual(reason, diff.REFUSAL_GONE_RATE)
        self.assertEqual(events, [])
        self.assertEqual(counts.gone_candidates, 6)

    def test_the_two_flags_reach_the_decision(self):
        before = self.fleet(10)
        after = list(before.values())
        for flags, want in (({"drift_passed": False}, diff.REFUSAL_DRIFT),
                            ({"self_tests_passed": False}, diff.REFUSAL_SELF_TEST)):
            with self.subTest(want=want):
                reason, events, _ = diff.run_diff(before, {}, after,
                                                  invented.published_of(after), TODAY, **flags)
                self.assertEqual(reason, want)
                self.assertEqual(events, [])


class WhatGetsRecordedMore(unittest.TestCase):
    """Round two R2-13 and R2-15, one run at a time."""

    WITHHELD = "Individual supplier (name withheld)"

    def test_every_live_row_is_recorded_changed_or_not_named_or_not(self):
        unchanged = snapshot_row(contract_key="aa-invented::PID-0001")
        withheld = snapshot_row(contract_key="aa-invented::PID-0002", reference="ZZ-TEST-0002",
                                vendor_key="", vendor_display=self.WITHHELD)
        fresh = snapshot_row(contract_key="aa-invented::PID-0003", reference="ZZ-TEST-0003")
        current = [unchanged, withheld, fresh]
        record = diff.rows_to_record(by_key([unchanged, withheld]), {}, current,
                                     invented.published_of(current), run_date=TODAY)
        self.assertEqual(record.live, current)

    def test_a_published_fact_with_no_reference_is_not_recorded(self):
        before = snapshot_row(end_date="2028-03-31")
        published = {before.contract_key: snapshot.PublishedFact(
            "aa-invented", "", invented.days(-7), 250_000.0)}
        record = diff.rows_to_record({before.contract_key: before}, {}, [], published, run_date=TODAY)
        self.assertEqual(record.refreshed, [], "an unlinkable row replaced a linkable one")
        # And it is kept under watch, with the row it had: its known end date
        # is still ahead, so it has not ended. Round three, 18 September 2026.
        self.assertEqual(record.live, [before])

    def test_a_blank_end_date_keeps_it_under_watch_until_its_known_end(self):
        before = snapshot_row(end_date="2028-03-31", value=250_000.0)
        blank = {before.contract_key: snapshot.PublishedFact(
            "aa-invented", "ZZ-TEST-0001-A1", None, 250_000.0)}
        record = diff.rows_to_record({before.contract_key: before}, {}, [], blank,
                                     run_date=TODAY)
        self.assertEqual([r.end_date for r in record.live], ["2028-03-31"])
        self.assertEqual(record.refreshed, [])

        # Past its known end date, it has ended: refreshed, not kept.
        ended = snapshot_row(end_date=invented.days(-1), value=250_000.0)
        record = diff.rows_to_record({ended.contract_key: ended}, {}, [], blank,
                                     run_date=TODAY)
        self.assertEqual(record.live, [])
        self.assertEqual(len(record.refreshed), 1)

        # And diff() counts the same one rows_to_record keeps: one rule.
        _, counts = diff.diff({before.contract_key: before}, {}, [], blank, TODAY)
        self.assertEqual(counts.kept_under_watch, 1)
        _, counts = diff.diff({ended.contract_key: ended}, {}, [], blank, TODAY)
        self.assertEqual(counts.kept_under_watch, 0)


if __name__ == "__main__":
    unittest.main()
