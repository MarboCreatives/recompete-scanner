"""Several weeks in a row. The faults one run cannot show.

Every case in test_diff.py looks at a single run. The adversarial review of
17 September 2026 found that the faults which mattered most only appeared
across runs: an old contract announced as new, a change absorbed between two
events, two events contradicting each other, a known date overwritten by a
blank one. Each case below is one of those sequences, driven through the real
pipeline — normalize, collect_refs, deduplicate, derive_category_names,
filter_recompete, build_snapshot, run_diff, rows_to_record — by
invented.WeeklyLoop, which holds contract_snapshot exactly the way PR B says
the writer must.

The government's record for each contract is the list of raw rows fed in. Every
assertion is against that record: an event must be true of it, and consecutive
events on one contract must chain — each "from" is where the previous "to" left
off.
"""

from __future__ import annotations

import unittest
from datetime import date

import diff
import snapshot
from tests import invented
from tests.invented import WeeklyLoop, background, source_row

K = "aa-invented::PID-0001"


def mine(events):
    """Events about the contract under test, not the background ones."""
    return [e for e in events if e.contract_key == K]


def moves(events, event_type):
    return [(e.payload["from"], e.payload["to"]) for e in mine(events)
            if e.event_type == event_type]


class AnOldContractIsNotANewAward(unittest.TestCase):
    """Late finding, round one, found by three lenses; and round two, again."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_an_option_year_on_a_contract_that_lapsed_before_tracking_began(self):
        # A 2024 contract ends 30 September 2026, a week before the baseline.
        # Its option year is signed on 20 September and published in the next
        # quarterly batch. The first version of diff.py said "New contract:
        # $150,000". The government's record shows an amendment.
        original = source_row(contract_date="2024-10-01", end_date="2026-09-30",
                              value=100_000.0)
        option = source_row(contract_date="2026-09-20", end_date="2027-09-30",
                            value=150_000.0, reference="ZZ-TEST-0001-A1")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [original], date(2026, 10, 5))
        weeks.run(self.bg + [original], date(2026, 10, 12))
        reason, events, counts = weeks.run(self.bg + [original, option], date(2026, 11, 2))

        self.assertIsNone(reason)
        self.assertEqual(
            [e.event_type for e in mine(events)], [],
            "an amended 2024 contract was announced as a new award",
        )
        self.assertEqual(counts.new_but_amended, 1, "held back, and counted")
        self.assertIsNotNone(weeks.recorded(K), "and recorded, so what follows is tracked")

    def test_after_that_it_is_tracked_like_any_other_contract(self):
        original = source_row(contract_date="2024-10-01", end_date="2026-09-30")
        option = source_row(contract_date="2026-09-20", end_date="2027-09-30",
                            reference="ZZ-TEST-0001-A1")
        second = source_row(contract_date="2026-11-10", end_date="2028-09-30",
                            reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [original], date(2026, 10, 5))
        weeks.run(self.bg + [original, option], date(2026, 11, 2))
        _, events, _ = weeks.run(self.bg + [original, option, second], date(2026, 11, 23))

        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2027-09-30", "2028-09-30")])

    def test_a_contract_with_no_end_date_at_the_baseline_that_gets_one(self):
        # Round two's K1: in the download, not live, so never recorded.
        undated = source_row(contract_date="2024-04-01", end_date="")
        dated = source_row(contract_date="2026-10-01", end_date="2027-09-30",
                           reference="ZZ-TEST-0001-A1")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [undated], date(2026, 9, 21))
        _, events, counts = weeks.run(self.bg + [undated, dated], date(2026, 10, 12))

        self.assertEqual(mine(events), [])
        self.assertEqual(counts.new_but_amended, 1)

    def test_a_genuinely_new_contract_is_still_a_new_award(self):
        # The fix must not switch NEW_AWARD off. One row, never seen: new.
        fresh = source_row(contract_date="2026-10-01", end_date="2027-09-30")
        weeks = WeeklyLoop()
        weeks.run(self.bg, date(2026, 10, 5))
        _, events, counts = weeks.run(self.bg + [fresh], date(2026, 10, 12))

        self.assertEqual([e.event_type for e in mine(events)], [diff.NEW_AWARD])
        self.assertEqual(counts.new_but_amended, 0)


class EventsChain(unittest.TestCase):
    """Each event starts where the last one on the same contract left off."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_a_lapsed_contract_changed_while_lapsed_is_reported_from_the_last_reported_state(self):
        # Round two, R2-7. Record: 250,000 -> 300,000 (A1) -> lapses ->
        # 280,000 close-out (A2, while lapsed) -> option year 350,000 (A3).
        # The first version absorbed A2 silently, so the return said
        # "from 280,000" when the last event had said "to 300,000".
        a0 = source_row(contract_date="2025-01-01", end_date="2026-10-31", value=250_000.0)
        a1 = source_row(contract_date="2026-10-08", end_date="2026-10-31", value=300_000.0,
                        reference="ZZ-TEST-0001-A1")
        a2 = source_row(contract_date="2026-11-12", end_date="2026-10-31", value=280_000.0,
                        reference="ZZ-TEST-0001-A2")
        a3 = source_row(contract_date="2026-11-20", end_date="2027-10-31", value=350_000.0,
                        reference="ZZ-TEST-0001-A3")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        _, e1, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 12))
        weeks.run(self.bg + [a0, a1], date(2026, 11, 9))           # lapsed
        _, e3, _ = weeks.run(self.bg + [a0, a1, a2], date(2026, 11, 16))
        _, e4, _ = weeks.run(self.bg + [a0, a1, a2, a3], date(2026, 11, 23))

        self.assertEqual(moves(e1, diff.VALUE_CHANGED), [("250000.00", "300000.00")])
        self.assertEqual(mine(e3), [], "not live either week: not news")
        self.assertEqual(
            moves(e4, diff.VALUE_CHANGED), [("300000.00", "350000.00")],
            "must start where the last event left off, or the feed contradicts itself",
        )
        self.assertEqual(moves(e4, diff.EXPIRY_MOVED), [("2026-10-31", "2027-10-31")])

    def test_terminated_then_reinstated_with_the_value_moving_too(self):
        # Round two, R2-12: the value half of the termination and the refresh.
        a0 = source_row(contract_date="2025-01-01", end_date="2027-03-31", value=250_000.0)
        cut = source_row(contract_date="2026-10-08", end_date="2026-10-05", value=100_000.0,
                         reference="ZZ-TEST-0001-A1")
        back = source_row(contract_date="2026-10-20", end_date="2028-03-31", value=400_000.0,
                          reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        _, e1, _ = weeks.run(self.bg + [a0, cut], date(2026, 10, 12))
        _, e2, _ = weeks.run(self.bg + [a0, cut, back], date(2026, 10, 26))

        self.assertEqual(moves(e1, diff.EXPIRY_MOVED), [("2027-03-31", "2026-10-05")])
        self.assertEqual(moves(e1, diff.VALUE_CHANGED), [("250000.00", "100000.00")])
        self.assertEqual(moves(e2, diff.EXPIRY_MOVED), [("2026-10-05", "2028-03-31")])
        self.assertEqual(moves(e2, diff.VALUE_CHANGED), [("100000.00", "400000.00")])


class ABlankNeverReplacesAKnownValue(unittest.TestCase):
    """Late round one #4, and round two R2-4, R2-5, R2-8."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_a_blank_end_date_then_a_real_extension(self):
        a0 = source_row(contract_date="2025-01-01", end_date="2027-03-31")
        blank = source_row(contract_date="2026-10-08", end_date="",
                           reference="ZZ-TEST-0001-A1")
        extension = source_row(contract_date="2026-10-20", end_date="2028-03-31",
                               reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        _, e1, _ = weeks.run(self.bg + [a0, blank], date(2026, 10, 12))
        self.assertEqual(mine(e1), [], "a blank date is not a date that moved")
        self.assertEqual(weeks.recorded(K).end_date, "2027-03-31",
                         "the known end date was overwritten by a blank")

        _, e2, _ = weeks.run(self.bg + [a0, blank, extension], date(2026, 10, 26))
        self.assertEqual(moves(e2, diff.EXPIRY_MOVED), [("2027-03-31", "2028-03-31")])

    def test_a_blank_value_on_a_live_contract_then_a_real_raise(self):
        a0 = source_row(contract_date="2025-01-01", value=240_000.0)
        blank = source_row(contract_date="2026-10-08", value="",
                           reference="ZZ-TEST-0001-A1")
        raised = source_row(contract_date="2026-10-20", value=410_000.0,
                            reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        _, e1, _ = weeks.run(self.bg + [a0, blank], date(2026, 10, 12))
        self.assertEqual(mine(e1), [])
        self.assertEqual(weeks.recorded(K).contract_value, 240_000.0)

        _, e2, _ = weeks.run(self.bg + [a0, blank, raised], date(2026, 10, 26))
        self.assertEqual(moves(e2, diff.VALUE_CHANGED), [("240000.00", "410000.00")])


class EveryLiveContractIsRecordedEveryWeek(unittest.TestCase):
    """Round two, R2-13: Record.live is every live contract, changed or not."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_an_unchanged_contract_can_still_go_the_week_after(self):
        # If only changed rows were recorded, this contract's last_seen_run
        # would stall, it would drop out of previous_live, and its withdrawal
        # would never be reported.
        a0 = source_row(end_date="2028-03-31")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        weeks.run(self.bg + [a0], date(2026, 10, 12))
        _, events, _ = weeks.run(self.bg, date(2026, 10, 19))

        self.assertEqual([e.event_type for e in mine(events)], [diff.CONTRACT_GONE])

    def test_a_withheld_individuals_contract_is_recorded_and_tracked(self):
        # M2-DESIGN 6 rule 4: a withheld individual's contract still updates
        # the snapshot. Its end date moving is still reported, with no key.
        a0 = source_row(vendor_name="QUILLERAN, Marisol", end_date="2027-03-31")
        a1 = source_row(vendor_name="QUILLERAN, Marisol", end_date="2028-03-31",
                        contract_date="2026-10-08", reference="ZZ-TEST-0001-A1")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        self.assertIsNotNone(weeks.recorded(K))
        _, events, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 12))

        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2027-03-31", "2028-03-31")])
        self.assertIsNone(mine(events)[0].vendor_key)


class RefusedWeeks(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_a_refused_week_writes_nothing_and_the_next_reports_the_change_once(self):
        a0 = source_row(end_date="2027-03-31")
        a1 = source_row(end_date="2028-03-31", contract_date="2026-10-08",
                        reference="ZZ-TEST-0001-A1")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        reason, events, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 12),
                                      drift_passed=False)
        self.assertEqual(reason, diff.REFUSAL_DRIFT)
        self.assertEqual(events, [])
        self.assertEqual(weeks.recorded(K).end_date, "2027-03-31", "a refused run wrote")

        _, events, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 19))
        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2027-03-31", "2028-03-31")])

    def test_the_same_week_run_twice_adds_nothing(self):
        a0 = source_row(end_date="2027-03-31")
        a1 = source_row(end_date="2028-03-31", contract_date="2026-10-08",
                        reference="ZZ-TEST-0001-A1")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [a0], date(2026, 10, 5))
        _, first, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 12))
        _, second, _ = weeks.run(self.bg + [a0, a1], date(2026, 10, 12))

        self.assertEqual(len(mine(first)), 1)
        self.assertEqual(second, [])


if __name__ == "__main__":
    unittest.main()
