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


class AnUnreadableRowIsNotAnEnding(unittest.TestCase):
    """Round three of the review, 18 September 2026. Fact (f) and its wider form.

    A contract whose latest amendment cannot be read leaves the live set while
    its known end date is still ahead. It used to leave previous_live with it,
    for good, so what the government did next was never reported. Each control
    below is the same change on a contract that stayed readable.
    """

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()
        self.a0 = source_row(contract_date="2025-01-01", end_date="2027-03-31", value=100_000.0)
        self.blank = source_row(contract_date="2026-10-08", end_date="", value=100_000.0,
                                reference="ZZ-TEST-0001-A1")
        self.cut = source_row(contract_date="2026-10-15", end_date="2026-10-14", value=60_000.0,
                              reference="ZZ-TEST-0001-A2")

    def blank_week(self, weeks, amendment):
        weeks.run(self.bg + [self.a0], date(2026, 10, 5))
        _, events, counts = weeks.run(self.bg + [self.a0, amendment], date(2026, 10, 12))
        # The premise, asserted: it really did leave the live set, silently.
        self.assertEqual(mine(events), [])
        self.assertEqual(counts.current_live, len(self.bg), "the contract must not be live")
        self.assertEqual(counts.kept_under_watch, 1)
        self.assertEqual(weeks.recorded(K).end_date, "2027-03-31")

    def test_withdrawn_after_a_blank_end_date_is_gone(self):
        weeks = WeeklyLoop()
        self.blank_week(weeks, self.blank)
        _, events, _ = weeks.run(self.bg, date(2026, 10, 19))
        self.assertEqual([(e.event_type, e.payload["last_end_date"]) for e in mine(events)],
                         [(diff.CONTRACT_GONE, "2027-03-31")])

    def test_terminated_after_a_blank_end_date_is_reported(self):
        weeks = WeeklyLoop()
        self.blank_week(weeks, self.blank)
        _, events, _ = weeks.run(self.bg + [self.a0, self.blank, self.cut], date(2026, 10, 19))
        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2027-03-31", "2026-10-14")])
        self.assertEqual(moves(events, diff.VALUE_CHANGED), [("100000.00", "60000.00")])

    def test_terminated_after_a_row_with_no_reference_is_reported(self):
        no_ref = source_row(contract_date="2026-10-08", end_date="2028-03-31",
                            value=150_000.0, reference="")
        weeks = WeeklyLoop()
        self.blank_week(weeks, no_ref)
        _, events, _ = weeks.run(self.bg + [self.a0, no_ref, self.cut], date(2026, 10, 19))
        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2027-03-31", "2026-10-14")])
        self.assertEqual(moves(events, diff.VALUE_CHANGED), [("100000.00", "60000.00")])

    def test_the_controls_the_same_changes_on_a_readable_contract(self):
        weeks = WeeklyLoop()
        weeks.run(self.bg + [self.a0], date(2026, 10, 5))
        _, gone, _ = weeks.run(self.bg, date(2026, 10, 19))
        self.assertEqual([e.event_type for e in mine(gone)], [diff.CONTRACT_GONE])

        weeks = WeeklyLoop()
        weeks.run(self.bg + [self.a0], date(2026, 10, 5))
        _, cut, _ = weeks.run(self.bg + [self.a0, self.cut], date(2026, 10, 19))
        self.assertEqual(moves(cut, diff.EXPIRY_MOVED), [("2027-03-31", "2026-10-14")])

    def test_it_is_watched_only_until_its_known_end_date(self):
        # Once the last readable end date passes, it has ended as far as
        # anything readable says, and an ended contract leaving is not news.
        near = source_row(contract_date="2025-01-01", end_date="2026-10-20", value=100_000.0)
        weeks = WeeklyLoop()
        weeks.run(self.bg + [near], date(2026, 10, 5))
        _, e1, c1 = weeks.run(self.bg + [near, self.blank], date(2026, 10, 12))
        _, e2, c2 = weeks.run(self.bg + [near, self.blank], date(2026, 10, 26))
        _, e3, _ = weeks.run(self.bg, date(2026, 11, 2))

        self.assertEqual((c1.kept_under_watch, c2.kept_under_watch), (1, 0))
        self.assertEqual(mine(e1) + mine(e2) + mine(e3), [])

    def test_it_is_still_watched_on_its_known_end_date(self):
        # The same boundary as the live rule: a contract ending today is live.
        # Review of 84fbbb3: a strict ">" passed every test, and lost this
        # backdated termination.
        today_end = source_row(contract_date="2025-01-01", end_date="2026-10-19",
                               value=100_000.0)
        backdated = source_row(contract_date="2026-10-22", end_date="2026-10-15",
                               value=100_000.0, reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [today_end], date(2026, 10, 12))
        _, _, counts = weeks.run(self.bg + [today_end, self.blank], date(2026, 10, 19))
        self.assertEqual(counts.kept_under_watch, 1, "its known end date is today")
        _, events, _ = weeks.run(self.bg + [today_end, self.blank, backdated],
                                 date(2026, 10, 26))
        self.assertEqual(moves(events, diff.EXPIRY_MOVED), [("2026-10-19", "2026-10-15")])

    def test_what_can_be_read_of_its_row_is_recorded(self):
        # Kept with its last good row: the good end date, and the NEW amount
        # the unreadable row does carry. Review of 84fbbb3: recording the old
        # stored row instead passed every test, repeated the same
        # VALUE_CHANGED every week, then reported the next raise from a figure
        # the first event had already moved away from.
        raised = source_row(contract_date="2026-10-08", end_date="", value=150_000.0,
                            reference="ZZ-TEST-0001-A1")
        again = source_row(contract_date="2026-10-22", end_date="", value=200_000.0,
                           reference="ZZ-TEST-0001-A2")
        weeks = WeeklyLoop()
        weeks.run(self.bg + [self.a0], date(2026, 10, 5))
        _, e1, c1 = weeks.run(self.bg + [self.a0, raised], date(2026, 10, 12))
        self.assertEqual(c1.kept_under_watch, 1, "the premise: kept, not live")
        self.assertEqual(moves(e1, diff.VALUE_CHANGED), [("100000.00", "150000.00")])
        self.assertEqual((weeks.recorded(K).end_date, weeks.recorded(K).contract_value),
                         ("2027-03-31", 150_000.0))

        _, e2, _ = weeks.run(self.bg + [self.a0, raised], date(2026, 10, 19))
        self.assertEqual(mine(e2), [], "nothing changed; nothing to say")
        _, e3, _ = weeks.run(self.bg + [self.a0, raised, again], date(2026, 10, 26))
        self.assertEqual(moves(e3, diff.VALUE_CHANGED), [("150000.00", "200000.00")])

    def test_a_wave_of_readable_terminations_is_still_refused(self):
        # The like-with-like count adds back KEPT contracts only. Ten of seventy
        # terminated at once, all readable and all still published, is still
        # the live-count drop the refusal exists for. Review of 84fbbb3: adding
        # back every still-published contract passed every test.
        fleet = [source_row(procurement_id=f"PID-T{i:02d}", reference=f"ZZ-TEST-T{i:02d}",
                            contract_date="2025-01-01", end_date="2027-03-31")
                 for i in range(10)]
        cut = [dict(r, delivery_date="2026-10-01", contract_date="2026-10-08",
                    reference_number=r["reference_number"] + "-A1") for r in fleet]
        weeks = WeeklyLoop()
        weeks.run(self.bg + fleet, date(2026, 10, 5))
        reason, events, counts = weeks.run(self.bg + fleet + cut, date(2026, 10, 12))
        self.assertEqual((counts.still_published, counts.kept_under_watch), (10, 0),
                         "the premise: still published, readable, not kept")
        self.assertEqual(reason, diff.REFUSAL_LIVE_COUNT_DROP)
        self.assertEqual(events, [])

    def test_many_kept_under_watch_do_not_refuse_the_weeks_after(self):
        # previous_live now holds kept contracts. Counted against the live set
        # alone they read as a drop every week, and a tenth of the fleet kept
        # would refuse every run until their end dates passed.
        blanked = [source_row(procurement_id=f"PID-UN{i:02d}", reference=f"ZZ-TEST-UN{i:02d}",
                              contract_date="2025-01-01", end_date="2027-03-31")
                   for i in range(10)]
        amended = [dict(r, delivery_date="", contract_date="2026-10-08",
                        reference_number=r["reference_number"] + "-A1") for r in blanked]
        weeks = WeeklyLoop()
        weeks.run(self.bg + blanked, date(2026, 10, 5))
        for day in (12, 19, 26):
            reason, events, counts = weeks.run(self.bg + blanked + amended, date(2026, 10, day))
            with self.subTest(day=day):
                self.assertIsNone(reason)
                self.assertEqual(events, [])
                self.assertEqual(counts.kept_under_watch, 10)


class AReferenceKeyIsNotANewAward(unittest.TestCase):
    """Round three, 18 September 2026. diff.py point 7."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_an_amendment_under_a_new_reference_says_nothing(self):
        # No procurement_id, so ingest keys each row on its reference number,
        # and the amendment arrives as a contract nobody has seen, with no
        # amendments of its own. The first version called it a new award.
        y0 = source_row(procurement_id="", reference="ZZ-TEST-Y0", end_date="2027-03-31",
                        value=100_000.0)
        y1 = source_row(procurement_id="", reference="ZZ-TEST-Y1", end_date="2028-03-31",
                        value=180_000.0, contract_date="2026-09-20")
        weeks = WeeklyLoop()
        _, _, c0 = weeks.run(self.bg + [y0], date(2026, 9, 17))
        _, events, counts = weeks.run(self.bg + [y0, y1], date(2026, 9, 24))

        self.assertEqual(counts.current_live, c0.current_live + 1,
                         "the premise: the amendment arrived as a second contract")
        self.assertEqual([e for e in events if e.event_type == diff.NEW_AWARD], [])
        self.assertEqual(counts.new_by_reference, 1)

    def test_the_same_contract_with_a_procurement_id_is_still_a_new_award(self):
        # The control: point 7 must not switch NEW_AWARD off for everyone.
        fresh = source_row(contract_date="2026-10-01", end_date="2027-09-30")
        weeks = WeeklyLoop()
        weeks.run(self.bg, date(2026, 10, 5))
        _, events, counts = weeks.run(self.bg + [fresh], date(2026, 10, 12))
        self.assertEqual([e.event_type for e in mine(events)], [diff.NEW_AWARD])
        self.assertEqual(counts.new_by_reference, 0)


class AnAmountTheDatabaseCannotHold(unittest.TestCase):
    """Round three, 18 September 2026. contract_value is numeric(16,2)."""

    def setUp(self):
        snapshot.load_site_rules()
        self.bg = background()

    def test_is_read_as_unknown_and_the_last_good_amount_stands(self):
        a0 = source_row(contract_date="2025-01-01", value=100_000.0)
        for bad in ("1e15", "inf", "nan"):
            with self.subTest(value=bad):
                huge = source_row(contract_date="2026-10-08", value=bad,
                                  reference="ZZ-TEST-0001-A1")
                weeks = WeeklyLoop()
                weeks.run(self.bg + [a0], date(2026, 10, 5))
                reason, events, counts = weeks.run(self.bg + [a0, huge], date(2026, 10, 12))
                self.assertIsNone(reason)
                self.assertEqual(mine(events), [], "no change from or to an unstorable amount")
                self.assertEqual(counts.values_unusable, 1)
                self.assertEqual(weeks.recorded(K).contract_value, 100_000.0)


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
