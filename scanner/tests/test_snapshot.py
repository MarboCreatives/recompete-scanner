"""Pipeline rows to snapshot rows, and the reference numbers that come with them.

M2-DESIGN sections 4, 5.1, 5.2 and 7.
"""

from __future__ import annotations

import unittest
from datetime import date

import snapshot
from tests import invented
from tests.invented import TODAY
from vendor import ingest


class WhatCountsAsLive(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_a_contract_ending_today_is_still_live(self):
        # The boundary, on its own, because off by one here drops every
        # contract on its last day and then reports it as gone the week after.
        for offset, kept in ((-1, False), (0, True), (1, True)):
            with self.subTest(offset=offset):
                rows = invented.pipeline_rows(
                    [invented.source_row(end_date=invented.days(offset))]
                )
                out, counts = snapshot.build_snapshot(rows, TODAY)
                self.assertEqual(len(out), 1 if kept else 0)
                self.assertEqual(counts.past_end_date, 0 if kept else 1)

    def test_the_run_date_decides_it_and_not_the_frozen_day_count(self):
        # A row downloaded months ago carries a days_to_expiry from then. Here
        # the contract ENDED ten days before the scan, but the stale row still
        # says it has 614 days left. The date says not live; the day count says
        # live. Only one of those is true.
        #
        # The first version of this case used a contract ending in ten days,
        # where the stale count and the date both say "live", so a day-count
        # filter passed it exactly as well as a date filter did. The break
        # harness swapped one filter for the other and the case did not notice.
        # A test of which filter decides has to use a row where they disagree.
        raw = invented.source_row(end_date=invented.days(-10))
        stale = invented.pipeline_rows([raw], today=date(2025, 1, 1))

        self.assertGreater(
            stale[0]["days_to_expiry"], 0,
            "the premise: the frozen day count must still say this is live",
        )

        out, counts = snapshot.build_snapshot(stale, TODAY)

        self.assertEqual(out, [], "an ended contract was kept on the word of a stale day count")
        self.assertEqual(counts.past_end_date, 1)

    def test_a_contract_with_no_end_date_is_not_kept_and_is_counted(self):
        rows = invented.pipeline_rows([invented.source_row(end_date="")])
        out, counts = snapshot.build_snapshot(rows, TODAY)
        self.assertEqual(out, [])
        self.assertEqual(counts.no_end_date, 1)


class RowsThatCannotBeUsed(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_a_contract_with_no_reference_number_is_dropped_and_counted(self):
        # Nobody can watch it — a watch key IS (org, ref) — and nothing can link
        # to the government's record, which is addressed by the same pair.
        rows = invented.pipeline_rows([invented.source_row(reference="")])
        out, counts = snapshot.build_snapshot(rows, TODAY)
        self.assertEqual(out, [])
        self.assertEqual(counts.no_reference, 1)

    def test_a_contract_with_no_supplier_is_dropped_and_counted(self):
        # Writing the withheld-individual label here would assert something
        # about a person that may not be true, and an empty name with an empty
        # key is refused by contract_snapshot_withheld_pairing anyway.
        rows = invented.pipeline_rows([invented.source_row(vendor_name="")])
        out, counts = snapshot.build_snapshot(rows, TODAY)
        self.assertEqual(out, [])
        self.assertEqual(counts.no_vendor_name, 1)

    def test_the_counts_add_up_to_what_went_in(self):
        rows = invented.pipeline_rows(
            [
                invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-1"),
                invented.source_row(procurement_id="PID-2", reference=""),
                invented.source_row(procurement_id="PID-3", vendor_name="",
                                    reference="ZZ-TEST-3"),
                invented.source_row(procurement_id="PID-4", reference="ZZ-TEST-4",
                                    end_date=invented.days(-5)),
                invented.source_row(procurement_id="PID-5", reference="ZZ-TEST-5",
                                    end_date=""),
            ]
        )
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(counts.rows_in, 5)
        self.assertEqual(counts.kept, 1)
        self.assertEqual(len(out), 1)
        self.assertEqual(counts.kept + counts.dropped, counts.rows_in)


class TheRowItBuilds(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_it_carries_what_the_table_needs(self):
        rows = invented.pipeline_rows(
            [invented.source_row(end_date="2027-03-31", value=250_000.0)]
        )
        row = snapshot.build_snapshot(rows, TODAY)[0][0]

        self.assertEqual(row.contract_key, "aa-invented::PID-0001")
        self.assertEqual(row.buyer_org_code, "aa-invented")
        self.assertEqual(row.reference_number, "ZZ-TEST-0001")
        self.assertEqual(row.buyer_org, "An Invented Department | Un ministere invente")
        self.assertEqual(row.vendor_display, "Northwind Widgets Inc")
        self.assertEqual(row.vendor_key, "northwind widgets")
        self.assertEqual(row.contract_value, 250_000.0)
        self.assertEqual(row.end_date, "2027-03-31")
        self.assertEqual(row.amendment_count, 1)

    def test_the_category_key_comes_from_the_sites_own_rule(self):
        # And from the site's own merge list. category_merges.txt holds
        # "Management consulting services => Management consulting", a line Jon
        # reviewed by hand, so the key is the merge TARGET. Asserting the
        # unmerged name here would pass with the merges file never loaded, which
        # is the exact silent failure load_site_rules refuses.
        rows = invented.pipeline_rows(
            [invented.source_row(description_en="Management consulting services")]
        )
        row = snapshot.build_snapshot(rows, TODAY)[0][0]
        self.assertEqual(row.category_key, "management consulting")

    def test_two_spellings_of_one_category_collapse_to_one_key(self):
        # What the merges file is for, and what an unloaded one silently undoes.
        rows = invented.pipeline_rows(
            [
                invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-1",
                                    description_en="Management consulting services"),
                invented.source_row(procurement_id="PID-2", reference="ZZ-TEST-2",
                                    commodity_code="R020",
                                    description_en="Management consulting"),
            ]
        )
        out, _ = snapshot.build_snapshot(rows, TODAY)
        self.assertEqual(len({r.category_key for r in out}), 1)

    def test_a_placeholder_category_becomes_no_category(self):
        # is_placeholder_category: a name carrying no subject a reader could
        # browse gets no key, so the contract stays fully visible under its
        # department without a category page being made for "N/A".
        rows = invented.pipeline_rows([invented.source_row(description_en="N/A")])
        out, counts = snapshot.build_snapshot(rows, TODAY)
        self.assertEqual(out[0].category_key, "")
        self.assertEqual(counts.no_category_key, 1)

    def test_the_amendment_count_is_what_ingest_collapsed(self):
        raws = [
            invented.source_row(contract_date="2025-04-01", value=100_000.0),
            invented.source_row(contract_date="2026-01-15", value=180_000.0,
                                reference="ZZ-TEST-0001-A1"),
            invented.source_row(contract_date="2026-06-30", value=240_000.0,
                                reference="ZZ-TEST-0001-A2"),
        ]
        rows = invented.pipeline_rows(raws)

        self.assertEqual(len(rows), 1, "three amendments are one contract")
        row = snapshot.build_snapshot(rows, TODAY)[0][0]
        self.assertEqual(row.amendment_count, 3)
        self.assertEqual(row.reference_number, "ZZ-TEST-0001-A2", "the latest one")
        self.assertEqual(row.contract_value, 240_000.0)


class EveryRowTheDatabaseWillAccept(unittest.TestCase):
    """contract_snapshot_withheld_pairing, held in Python. Review, 17 Sep.

    Migration 0004 refuses any row where an empty vendor_key and the withheld
    label do not go together. M2-DESIGN 6 rule 7 commits the whole week in one
    transaction, so ONE such row anywhere in ~25,000 rolls the week back and
    loses every event in it. The constraint is the tripwire; build_snapshot is
    the enforcement point, and these cases hold it to that.

    The adversarial review found two shapes that tripped it, both by running
    them: a company whose name is nothing but legal words, and the withheld label
    arriving in the source already written.
    """

    WITHHELD = "Individual supplier (name withheld)"

    def setUp(self):
        snapshot.load_site_rules()

    def pairing_holds(self, row):
        return (row.vendor_key == "") == (row.vendor_display == self.WITHHELD)

    def test_a_company_named_only_in_legal_words_is_dropped_and_counted(self):
        # ingest.vendor_key strips VENDOR_STOPWORDS, so every word of these goes
        # and the key is empty — beside a real company name.
        for name in ("The Company Inc", "Canada Ltd", "Holdings Group Inc",
                     "THE CANADA COMPANY LIMITED"):
            with self.subTest(name=name):
                rows = invented.pipeline_rows([invented.source_row(vendor_name=name)])
                self.assertEqual(rows[0]["vendor_key"], None, "the premise: no key survives")

                out, counts = snapshot.build_snapshot(rows, TODAY)

                self.assertEqual(out, [], "a row the database would refuse got out")
                self.assertEqual(counts.unkeyed_company, 1)

    def test_the_withheld_label_arriving_in_the_source_gets_no_key(self):
        # The label means "a private person", whoever wrote it, so a key beside
        # it would be a watchable identity for someone the label says is private.
        rows = invented.pipeline_rows(
            [invented.source_row(vendor_name=self.WITHHELD)]
        )
        self.assertTrue(rows[0]["vendor_key"], "the premise: ingest gave it a key")

        out, _ = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].vendor_display, self.WITHHELD)
        self.assertEqual(out[0].vendor_key, "")

    def test_every_row_that_leaves_satisfies_the_pairing_whatever_went_in(self):
        # Every kind of supplier name there is a fixture for, in one run. Not a
        # sample: the property the database enforces, asserted row by row.
        names = (
            [n for n, _ in invented.INDIVIDUALS]
            + [n for n, _ in invented.ORGANISATIONS]
            + [invented.ALLOWLISTED_ORGANISATION, invented.NAME_THE_RULES_MISS,
               "The Company Inc", "Canada Ltd", self.WITHHELD, ""]
        )
        raws = [
            invented.source_row(procurement_id=f"PID-{n:03d}",
                                reference=f"ZZ-TEST-{n:03d}", vendor_name=name)
            for n, name in enumerate(names)
        ]
        out, counts = snapshot.build_snapshot(invented.pipeline_rows(raws), TODAY)

        self.assertGreater(len(out), 10, "the fixture must produce a real batch")
        for row in out:
            with self.subTest(key=row.contract_key):
                self.assertTrue(self.pairing_holds(row))
        self.assertEqual(counts.kept + counts.dropped, counts.rows_in)


class KeyedByReference(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_a_contract_with_no_procurement_id_is_counted(self):
        # ingest.build_contract_key falls back to "{org}::REF::{ref}" without a
        # procurement_id, and that key changes when the reference does, so an
        # amendment to such a contract looks like one ending and another
        # beginning. Counted rather than handled, so PR C measures whether it
        # happens on real data instead of anybody assuming either way.
        rows = invented.pipeline_rows(
            [
                invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-1"),
                invented.source_row(procurement_id="", reference="ZZ-TEST-2"),
            ]
        )
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(len(out), 2)
        self.assertEqual(counts.keyed_by_reference, 1)
        self.assertIn("aa-invented::REF::ZZ-TEST-2", {r.contract_key for r in out})


class ItDoesNotTouchWhatItWasGiven(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_the_callers_rows_come_back_unchanged(self):
        # suppress_individuals and add_category_key both mutate in place on the
        # site. Copying first means this module cannot reach into a list
        # somebody else is still holding.
        rows = invented.pipeline_rows(
            [invented.source_row(vendor_name="QUILLERAN, Marisol")]
        )
        before = [dict(r) for r in rows]

        snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(rows, before)
        self.assertNotIn("category_key", rows[0], "a key was added to the caller's row")


class ReferenceNumbers(unittest.TestCase):
    """collect_refs, the scanner's one addition to the ingest copy."""

    def setUp(self):
        snapshot.load_site_rules()

    def test_every_amendments_reference_survives_the_collapse(self):
        # The whole point. deduplicate() keeps the latest amendment and throws
        # the earlier rows away, and it is the earlier ones that carry the
        # reference numbers people are already watching.
        raws = [
            invented.source_row(contract_date="2025-04-01", reference="ZZ-TEST-0001"),
            invented.source_row(contract_date="2026-01-15", reference="ZZ-TEST-0001-A1"),
            invented.source_row(contract_date="2026-06-30", reference="ZZ-TEST-0001-A2"),
        ]
        refs = invented.refs_of(raws)

        self.assertEqual(
            sorted(refs),
            [
                ("aa-invented", "ZZ-TEST-0001"),
                ("aa-invented", "ZZ-TEST-0001-A1"),
                ("aa-invented", "ZZ-TEST-0001-A2"),
            ],
        )
        self.assertEqual(set(refs.values()), {"aa-invented::PID-0001"})

    def test_it_would_be_empty_if_it_ran_after_the_collapse(self):
        # A guard on the ordering rather than on the output. Running it on the
        # deduplicated rows silently gives one reference per contract, which
        # looks entirely reasonable and loses every older watch key.
        raws = [
            invented.source_row(contract_date="2025-04-01", reference="ZZ-TEST-0001"),
            invented.source_row(contract_date="2026-06-30", reference="ZZ-TEST-0001-A2"),
        ]
        normalized = [ingest.normalize(r, today=TODAY) for r in raws]
        after_collapse, _ = ingest.collect_refs(ingest.deduplicate(normalized))

        self.assertEqual(len(after_collapse), 1)
        self.assertEqual(len(invented.refs_of(raws)), 2)

    def test_the_same_reference_under_two_departments_is_two_contracts(self):
        # GROUND-TRUTH G23: a reference number alone is not unique; the pair is.
        raws = [
            invented.source_row(org="aa-invented", procurement_id="PID-1",
                                reference="ZZ-TEST-SAME"),
            invented.source_row(org="bb-invented", procurement_id="PID-2",
                                reference="ZZ-TEST-SAME"),
        ]
        refs = invented.refs_of(raws)

        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[("aa-invented", "ZZ-TEST-SAME")], "aa-invented::PID-1")
        self.assertEqual(refs[("bb-invented", "ZZ-TEST-SAME")], "bb-invented::PID-2")

    def test_half_an_empty_pair_is_not_collected(self):
        # contract_refs_halves_present in 0004 refuses these. Dropping them here
        # keeps the whole run in one transaction instead of failing the insert.
        raws = [
            invented.source_row(procurement_id="PID-1", reference=""),
            invented.source_row(procurement_id="PID-2", org="", reference="ZZ-TEST-2"),
        ]
        self.assertEqual(invented.refs_of(raws), {})

    def test_a_pair_pointing_at_two_contracts_is_counted_not_hidden(self):
        # G23 says this cannot happen. It is a measurement of the data as it
        # was, not a promise about the data as it will be, so the count exists.
        # A count, never a reference number: this is a public repository.
        raws = [
            invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-SAME"),
            invented.source_row(procurement_id="PID-2", reference="ZZ-TEST-SAME"),
        ]
        normalized = [ingest.normalize(r, today=TODAY) for r in raws]
        mapping, conflicts = ingest.collect_refs(normalized)

        self.assertEqual(conflicts, 1)
        self.assertEqual(len(mapping), 1)
        self.assertEqual(
            mapping[("aa-invented", "ZZ-TEST-SAME")], "aa-invented::PID-1",
            "the first one seen wins, and the count is what says so",
        )

    def test_only_pairs_pointing_into_this_snapshot_are_offered(self):
        # contract_refs has a foreign key to contract_snapshot, so a pair
        # pointing anywhere else cannot be written.
        raws = [
            invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-1"),
            invented.source_row(procurement_id="PID-2", reference="ZZ-TEST-2",
                                end_date=invented.days(-30)),
        ]
        rows = invented.pipeline_rows(raws)
        out, _ = snapshot.build_snapshot(rows, TODAY)
        refs = snapshot.refs_in_snapshot(invented.refs_of(raws), out)

        self.assertEqual(len(out), 1, "the second contract ended and is not live")
        self.assertEqual(sorted(refs), [("aa-invented", "ZZ-TEST-1")])


class TheWholePipeline(unittest.TestCase):
    """snapshot.pipeline: the ordering, in one place, so scan.py cannot get it wrong."""

    def setUp(self):
        snapshot.load_site_rules()

    def test_it_collects_references_before_it_collapses_amendments(self):
        raws = [
            invented.source_row(contract_date="2025-04-01", reference="ZZ-TEST-0001"),
            invented.source_row(contract_date="2026-06-30", reference="ZZ-TEST-0001-A2"),
        ]
        rows, refs, conflicts, _ = snapshot.pipeline(raws, TODAY)

        self.assertEqual(len(rows), 1, "two amendments, one contract")
        self.assertEqual(len(refs), 2, "both references, or the older watch key is lost")
        self.assertEqual(conflicts, 0)

    def test_it_names_the_categories_before_they_are_keyed(self):
        # Skipping derive_category_names leaves every key as the raw commodity
        # code, which looks like a key and is not a subject anybody can browse.
        rows, _, _, _ = snapshot.pipeline(
            [invented.source_row(description_en="Management consulting services")], TODAY
        )
        out, _ = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(out[0].category_key, "management consulting")
        self.assertNotEqual(out[0].category_key, "R019", "the commodity code got through")

    def test_it_keeps_only_the_commodity_types_whose_end_date_means_the_end(self):
        # G is goods: delivery_date only MAY be the end date, so the site
        # excludes them and the scanner sees the same universe it does.
        raws = [
            invented.source_row(procurement_id="PID-S", reference="ZZ-TEST-S",
                                commodity_type="S"),
            invented.source_row(procurement_id="PID-C", reference="ZZ-TEST-C",
                                commodity_type="C"),
            invented.source_row(procurement_id="PID-G", reference="ZZ-TEST-G",
                                commodity_type="G"),
        ]
        rows, _, _, _ = snapshot.pipeline(raws, TODAY)

        self.assertEqual(
            sorted(r["contract_key"] for r in rows),
            ["aa-invented::PID-C", "aa-invented::PID-S"],
        )

    def test_the_date_filter_is_the_one_that_decides_at_the_boundary(self):
        # filter_recompete drops a row whose FROZEN days_to_expiry is negative;
        # build_snapshot drops one whose end date is past. Over a download that
        # is not from today, only the second is right, and it is applied last.
        downloaded = date(2026, 8, 1)
        raws = [
            invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-1",
                                end_date="2026-09-01"),
        ]
        rows, _, _, _ = snapshot.pipeline(raws, downloaded)
        self.assertEqual(len(rows), 1, "live when it was downloaded")

        out, counts = snapshot.build_snapshot(rows, date(2026, 9, 17))
        self.assertEqual(out, [], "not live on the day the scan runs")
        self.assertEqual(counts.past_end_date, 1)

    def test_a_conflicting_pair_is_reported_rather_than_swallowed(self):
        raws = [
            invented.source_row(procurement_id="PID-1", reference="ZZ-TEST-SAME"),
            invented.source_row(procurement_id="PID-2", reference="ZZ-TEST-SAME"),
        ]
        _, _, conflicts, _ = snapshot.pipeline(raws, TODAY)
        self.assertEqual(conflicts, 1)


class TheLogLine(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_it_reports_every_reason_a_row_was_dropped(self):
        # A single "dropped 15" tells nobody whether the download was short or
        # the data changed shape, and PR C tunes the refusal thresholds from
        # exactly these figures. Each reason gets a DIFFERENT count, so every
        # one is pinned to its own phrase; the first version gave most of them
        # 1 and asserted only the total, so the breakdown could vanish and the
        # case still pass (review, late round one #18).
        counts = snapshot.SnapshotCounts(
            rows_in=100, kept=70, past_end_date=1, no_end_date=2, no_reference=3,
            no_vendor_name=4, unkeyed_company=5, suppressed=6, no_category_key=7,
            keyed_by_reference=8,
        )
        line = snapshot.report(counts)

        self.assertEqual(counts.dropped, 15)
        for phrase in (
            "100 rows in", "70 live contracts kept", "15 dropped",
            "1 past their end date", "2 with no end date", "3 with no reference number",
            "4 with no supplier", "5 with a supplier name that has no key",
            "6 supplier names withheld", "7 with no category", "8 keyed by reference number",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, line)


class Resuppress(unittest.TestCase):
    """A stored row, judged again by today's rules. See diff.ANameTheRulesNowWithhold."""

    WITHHELD = "Individual supplier (name withheld)"

    def setUp(self):
        snapshot.load_site_rules()

    def test_a_name_today_withholds_is_withheld(self):
        row = invented.snapshot_row(vendor_key="dana quilleran", vendor_display="DANA QUILLERAN")
        again = snapshot.resuppress(row)
        self.assertEqual((again.vendor_key, again.vendor_display), ("", self.WITHHELD))
        self.assertEqual(again.end_date, row.end_date, "only the supplier changes")

    def test_a_company_is_returned_untouched(self):
        row = invented.snapshot_row()
        self.assertIs(snapshot.resuppress(row), row)

    def test_the_allowlist_is_honoured(self):
        row = invented.snapshot_row(vendor_key="raymond chabot grant thornton",
                                    vendor_display=invented.ALLOWLISTED_ORGANISATION)
        self.assertIs(snapshot.resuppress(row), row)

    def test_a_withheld_row_stays_withheld_and_loses_any_stray_key(self):
        row = invented.snapshot_row(vendor_key="", vendor_display=self.WITHHELD)
        self.assertIs(snapshot.resuppress(row), row)
        stray = invented.snapshot_row(vendor_key="leftover", vendor_display=self.WITHHELD)
        self.assertEqual(snapshot.resuppress(stray).vendor_key, "")


if __name__ == "__main__":
    unittest.main()
