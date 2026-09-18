"""Names. The one thing here that cannot be undone if it is wrong.

CODING-STANDARDS 3: never write a suppressed name anywhere — not to a log, not
to a cache, not to an error message. M2-DESIGN 7 applies that to this milestone:
an invented individual's name must not reach a snapshot row, an event, or
anything printed.

CODING-STANDARDS 2.4 shapes how it is checked. The main project learned this the
hard way: its name-suppression audit called the same function it was validating,
so it could not detect that function being too narrow, and it passed while names
were being published. So nothing below asks is_individual what ought to be
withheld. tests/invented.py declares, by hand and with the rule each one
exercises written next to it, which invented names are people. That list is the
oracle. If is_individual narrows, this fails.

A suppression test that has never failed is not evidence of anything
(CODING-STANDARDS 7). harness/break-scanner-code.py disables suppression and
confirms the cases below fail; the result is in PROGRESS.md.
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import diff
import snapshot
from tests import invented
from tests.invented import TODAY, by_key

# The literal the site substitutes, and the literal
# contract_snapshot_withheld_pairing in migration 0004 spells out. Written here
# as a plain string on purpose: importing PERSON_LABEL from the code under test
# would make this assertion tautological, and the database constraint cannot
# import it either.
WITHHELD = "Individual supplier (name withheld)"


def rows_for(names_and_why, start=0, **over):
    """One raw source row per name, each with its own contract and reference.

    `start` numbers the contracts. Two lists built from 0 share contract keys,
    and deduplicate then merges one list's rows into the other's.
    """
    return [
        invented.source_row(
            procurement_id=f"PID-{n:04d}",
            reference=f"{invented.REF_PREFIX}-{n:04d}",
            vendor_name=name,
            **over,
        )
        for n, (name, _why) in enumerate(names_and_why, start)
    ]


class SuppressionIsApplied(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()

    def test_the_withheld_label_is_the_exact_string_the_database_requires(self):
        # contract_snapshot_withheld_pairing in 0004_scanner.sql compares
        # against this literal. A character out of place here is an insert that
        # fails at 07:00 on a Monday, after the download, inside the one
        # transaction the whole run commits in.
        from vendor import names

        self.assertEqual(names.PERSON_LABEL, WITHHELD)

    def test_every_invented_person_is_withheld(self):
        rows = invented.pipeline_rows(rows_for(invented.INDIVIDUALS))
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(len(out), len(invented.INDIVIDUALS))
        self.assertEqual(counts.suppressed, len(invented.INDIVIDUALS))
        for row, (name, why) in zip(out, invented.INDIVIDUALS):
            with self.subTest(rule=why):
                self.assertEqual(row.vendor_display, WITHHELD, f"{why} stopped working")
                self.assertEqual(row.vendor_key, "", "the key must be blanked too")

    def test_no_invented_person_reaches_a_snapshot_row_in_any_field(self):
        # Not "vendor_display does not hold the name" but "no field does". A
        # future column that carried it would pass the narrower check.
        rows = invented.pipeline_rows(rows_for(invented.INDIVIDUALS))
        out, _ = snapshot.build_snapshot(rows, TODAY)

        haystack = " ".join(
            str(value) for row in out for value in vars(row).values()
        ).upper()
        for token in invented.INVENTED_TOKENS:
            if token in ("NORTHWIND",):
                continue  # a company; it is supposed to be there
            with self.subTest(token=token):
                self.assertNotIn(token, haystack)

    def test_no_invented_person_reaches_an_event(self):
        # The snapshot is not the only way out. An event carries a vendor_key, a
        # payload and a dedupe key, and all three are written to a public table.
        #
        # What this case does NOT cover, said plainly because the review found
        # the first wording claimed more: an Event has no vendor_display field,
        # so a leak that blanks the key but keeps the NAME cannot reach an event
        # at all and this case cannot see it. That leak is caught by
        # test_no_invented_person_reaches_a_snapshot_row_in_any_field, which
        # searches every field of the row. The two together cover both halves;
        # this one alone covers the key, payload and dedupe-key paths.
        raws = rows_for(invented.INDIVIDUALS)
        before_rows = invented.pipeline_rows(raws)
        after_raws = rows_for(invented.INDIVIDUALS, end_date="2029-03-31", value=999_000.0)
        after_rows = invented.pipeline_rows(after_raws)

        before, _ = snapshot.build_snapshot(before_rows, TODAY)
        after, _ = snapshot.build_snapshot(after_rows, TODAY)
        events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY, base_run=7)

        self.assertGreater(len(events), 0, "the fixture must actually produce events")
        haystack = " ".join(
            f"{e.event_type} {e.contract_key} {e.contract_ref} {e.vendor_key} "
            f"{e.dedupe_key} {e.payload}"
            for e in events
        ).upper()
        for token in invented.INVENTED_TOKENS:
            if token in ("NORTHWIND",):
                continue
            with self.subTest(token=token):
                self.assertNotIn(token, haystack)

    def test_a_company_keeps_its_name_and_its_key(self):
        # The trade is deliberate and runs one way: withholding a company name
        # costs a reader a label, missing a person exposes them. But it is still
        # a cost, and a rule that withheld everything would pass a test that
        # only looked for leaks.
        rows = invented.pipeline_rows(rows_for(invented.ORGANISATIONS))
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(counts.suppressed, 0)
        for row, (name, why) in zip(out, invented.ORGANISATIONS):
            with self.subTest(why=why):
                self.assertEqual(row.vendor_display, name)
                self.assertNotEqual(row.vendor_key, "")

    def test_the_allowlist_gives_a_company_its_name_back(self):
        # vendor_allowlist.txt is the correction channel for a real organisation
        # the rules read as a person. Without it loaded, this name is withheld.
        rows = invented.pipeline_rows(
            [invented.source_row(vendor_name=invented.ALLOWLISTED_ORGANISATION)]
        )
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(counts.suppressed, 0)
        self.assertEqual(out[0].vendor_display, invented.ALLOWLISTED_ORGANISATION)

    def test_the_rules_are_not_claimed_to_catch_every_person(self):
        # is_individual's own docstring says the given-name test is not a
        # census, and this name proves it: "marisol" is on no list, so a real
        # person's name is published. It is recorded here rather than left
        # implicit, because a test suite that showed only successes would read
        # as a guarantee the code does not give. The display path in the app is
        # the second gate, and the allowlist is the correction channel.
        rows = invented.pipeline_rows(
            [invented.source_row(vendor_name=invented.NAME_THE_RULES_MISS)]
        )
        out, counts = snapshot.build_snapshot(rows, TODAY)

        self.assertEqual(counts.suppressed, 0)
        self.assertEqual(out[0].vendor_display, invented.NAME_THE_RULES_MISS)


class TheRulesMustBeLoaded(unittest.TestCase):
    """Three guards, each checked on its own, because any one catches the others' case.

    The first version had one case, asserting only that SOMETHING was raised.
    The break harness showed that removing the file-exists guard left the
    empty-allowlist guard to catch the same input. The second version split
    those two, but still pointed at a folder missing BOTH files, so the merges
    file's own check was never seen to fail (review, late round one #16 and
    R2-14). Each case now has exactly one thing wrong, and asserts the name of
    the file that is wrong.
    """

    def folder_with(self, folder, allowlist=True, merges=True, allowlist_text=None):
        if allowlist:
            with open(os.path.join(folder, "vendor_allowlist.txt"), "w", encoding="utf-8") as fh:
                fh.write(allowlist_text if allowlist_text is not None
                         else "RAYMOND CHABOT GRANT THORNTON\n")
        if merges:
            with open(os.path.join(folder, "category_merges.txt"), "w", encoding="utf-8") as fh:
                fh.write("Management consulting services => Management consulting\n")
        return folder

    def test_a_missing_allowlist_refuses_rather_than_changing_the_answer(self):
        # load_vendor_allowlist treats a missing file as "nothing to load",
        # which is right for the site and silently wrong here: an empty
        # allowlist suppresses MORE, so a real company would be withheld every
        # week and nothing would say so.
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(snapshot.RulesNotLoaded) as caught:
                snapshot.load_site_rules(vendor_dir=self.folder_with(folder, allowlist=False))
        self.assertIn("vendor_allowlist.txt is missing", str(caught.exception))

    def test_a_missing_category_merges_file_refuses(self):
        # Unloaded, two spellings of one category become two keys, which then
        # go into contract_snapshot and NEW_AWARD payloads and differ from the
        # site's.
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(snapshot.RulesNotLoaded) as caught:
                snapshot.load_site_rules(vendor_dir=self.folder_with(folder, merges=False))
        self.assertIn("category_merges.txt is missing", str(caught.exception))

    def test_an_allowlist_that_reads_as_empty_refuses_too(self):
        # A file that exists and holds nothing is the same fault wearing a
        # disguise: a truncated checkout, a merge that ate the contents, a
        # file of nothing but comments.
        with tempfile.TemporaryDirectory() as folder:
            self.folder_with(folder, allowlist_text="# every line a comment\n")
            with self.assertRaises(snapshot.RulesNotLoaded) as caught:
                snapshot.load_site_rules(vendor_dir=folder)
        self.assertIn("held no entries", str(caught.exception))

    def test_both_files_present_loads(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(snapshot.load_site_rules(vendor_dir=self.folder_with(folder)), (1, 1))
        snapshot.load_site_rules()  # put the real rules back for later cases


class NothingIsPrinted(unittest.TestCase):
    """M2-DESIGN 7: workflow logs print counts only. No name, no key, no ref.

    Every channel a GitHub Actions log records: stdout, stderr and the logging
    module. The first version captured stdout only, so a name printed to
    stderr — where this repository's own drift.py writes — passed the whole
    suite (review, late round one #14).
    """

    def setUp(self):
        snapshot.load_site_rules()

    def capture(self, fn):
        out, err = io.StringIO(), io.StringIO()
        handler = logging.StreamHandler(err)
        root = logging.getLogger()
        previous = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            with redirect_stdout(out), redirect_stderr(err):
                fn()
        finally:
            root.removeHandler(handler)
            root.setLevel(previous)
        return out.getvalue(), err.getvalue()

    def test_building_a_snapshot_prints_nothing_at_all(self):
        rows = invented.pipeline_rows(rows_for(invented.INDIVIDUALS))
        out, err = self.capture(lambda: snapshot.build_snapshot(rows, TODAY))
        self.assertEqual(out, "", "build_snapshot printed to stdout")
        self.assertEqual(err, "", "build_snapshot printed to stderr or logged")

    def test_diffing_and_recording_print_nothing_at_all(self):
        before = [invented.snapshot_row(end_date="2027-03-31")]
        after = [invented.snapshot_row(end_date="2028-03-31")]
        pub = invented.published_of(after)

        def run():
            diff.run_diff(by_key(before), {}, after, pub, TODAY, base_run=7, self_tests_passed=True, drift_passed=True)
            diff.rows_to_record(by_key(before), {}, after, pub, run_date=TODAY)

        out, err = self.capture(run)
        self.assertEqual((out, err), ("", ""))

    def test_the_whole_pipeline_prints_nothing_at_all(self):
        raws = rows_for(invented.INDIVIDUALS)
        out, err = self.capture(lambda: snapshot.pipeline(raws, TODAY))
        self.assertEqual((out, err), ("", ""))

    def test_what_the_scanner_does_print_holds_no_name_and_no_reference(self):
        # The reports are the only thing written to the log, so they are what a
        # public Actions log would show. Printed here exactly as scan.py will.
        #
        # The companies are numbered from 100. Round three, 18 September 2026:
        # numbered from 0 like the individuals, they shared contract keys with
        # them, deduplicate merged them away, and no event carried a supplier
        # at all — so a report printing supplier keys passed this test.
        raws = rows_for(invented.INDIVIDUALS) + rows_for(invented.ORGANISATIONS, 100)
        rows = invented.pipeline_rows(raws)
        before, snap_counts = snapshot.build_snapshot(rows, TODAY)

        after_rows = invented.pipeline_rows(
            rows_for(invented.INDIVIDUALS, end_date="2029-03-31")
            + rows_for(invented.ORGANISATIONS, 100, end_date="2029-03-31")
        )
        after, _ = snapshot.build_snapshot(after_rows, TODAY)
        reason, events, diff_counts = diff.run_diff(
            by_key(before), {}, after, invented.published_of(after), TODAY, base_run=7, self_tests_passed=True, drift_passed=True)
        # The premise: companies reach events, carrying their keys. Without
        # this, "no name reached the log" can hold because there was none.
        self.assertIsNone(reason)
        self.assertGreaterEqual(sum(1 for e in events if e.vendor_key), len(invented.ORGANISATIONS))

        def run():
            print(snapshot.report(snap_counts))
            print(diff.report(diff_counts, reason))
            print(diff.events_by_type(events))

        out, err = self.capture(run)
        printed = out + err

        self.assertGreater(len(printed), 100, "the fixture must produce a real log")
        upper = printed.upper()
        for token in invented.INVENTED_TOKENS:
            with self.subTest(token=token):
                self.assertNotIn(token, upper, "a supplier name reached the log")
        self.assertNotIn(invented.REF_PREFIX, upper, "a reference number reached the log")
        self.assertNotIn("SOMEBODY", upper, "the buyer's name reached the log")
        self.assertNotIn(WITHHELD.upper(), upper)


class NothingPrintsAName(unittest.TestCase):
    """A repr is printed wherever an object is logged, formatted or asserted about.

    NothingIsPrinted checks what the code prints. This checks what the objects
    print when somebody ELSE prints them: logging.error("bad run %s", pipe) in
    scan.py, an f-string in an exception message, an assert with the object as
    its message, a traceback that shows a caller's locals. Outside review, item
    12, 18 September 2026: the default NamedTuple and dataclass reprs printed
    every field. Names only: references and contract keys still print in the
    reprs of rows and events, and M2-DESIGN 7's 'no reference in a log' is kept
    where logs are written, which is report() here and scan.py in PR D.
    """

    def setUp(self):
        snapshot.load_site_rules()

    def pipe(self):
        raws = rows_for(invented.INDIVIDUALS) + rows_for(invented.ORGANISATIONS, 100)
        pipe = snapshot.pipeline(raws, TODAY)
        # The premise: the rows really do hold every invented person's name,
        # unsuppressed. Without this the case passes on an empty pipeline.
        held = " ".join(str(r["vendor_name"]) for r in pipe.rows).upper()
        for name, _why in invented.INDIVIDUALS:
            self.assertIn(name.upper(), held)
        return pipe

    def assert_no_name(self, text, how):
        upper = text.upper()
        for token in invented.INVENTED_TOKENS:
            with self.subTest(how=how, token=token):
                self.assertNotIn(token, upper, f"{how} printed a supplier name")

    def test_a_pipeline_prints_counts_only_however_it_is_printed(self):
        pipe = self.pipe()
        for how, text in [
            ("repr(pipe)", repr(pipe)),
            ("str(pipe)", str(pipe)),
            ("f'{pipe}'", f"{pipe}"),
            ("format(pipe)", format(pipe, "")),
            ("'%s' % pipe", "%s" % (pipe,)),
            ("repr(pipe.rows)", repr(pipe.rows)),
            ("repr(pipe.rows[0])", repr(pipe.rows[0])),
            ("str(pipe.rows[0])", str(pipe.rows[0])),
            ("repr(pipe._asdict())", repr(pipe._asdict())),
        ]:
            self.assert_no_name(text, how)
        # M2-DESIGN 7 says no reference number either. The pipeline itself can
        # keep that promise; _asdict() cannot, since it hands out refs and
        # published as they are, so it is checked for names only.
        for how, text in [("repr(pipe)", repr(pipe)), ("str(pipe)", str(pipe)),
                          ("repr(pipe.rows)", repr(pipe.rows))]:
            with self.subTest(how=how):
                self.assertNotIn(invented.REF_PREFIX, text.upper(), f"{how} printed a reference")
        self.assertIn(f"{len(pipe.rows):,} live rows", repr(pipe), "counts, not nothing")

    def test_logging_a_pipeline_prints_no_name(self):
        pipe = self.pipe()
        err = io.StringIO()
        handler = logging.StreamHandler(err)
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            logging.error("bad run %s", pipe)
            logging.error("rows %s", pipe.rows)
            logging.error("first %r", pipe.rows[0])
        finally:
            root.removeHandler(handler)
        self.assertIn("bad run", err.getvalue(), "the premise: something was logged")
        self.assert_no_name(err.getvalue(), "logging")

    def test_a_pipeline_held_by_the_caller_prints_no_name_in_its_locals(self):
        # Only what a CALLER holds. A frame INSIDE pipeline() or build_snapshot()
        # holds plain dicts and the site's own ingest.Contract objects, which no
        # repr here can re-type: shown on 18 September 2026 to print every name.
        # So the rule for PR D stands on its own: scan.py never shows locals in a
        # traceback (no capture_locals, no show-locals handler).
        import sys
        import traceback

        pipe = self.pipe()

        def fails(pipe=pipe, rows=pipe.rows, row=pipe.rows[0]):
            raise RuntimeError(f"bad run {pipe}")

        try:
            fails()
        except RuntimeError:
            text = "".join(traceback.TracebackException(
                *sys.exc_info(), capture_locals=True).format())
        self.assertIn("bad run", text)
        self.assert_no_name(text, "a traceback with locals")

    def test_a_row_read_back_under_older_rules_prints_no_name(self):
        # What PR D reads from contract_snapshot before diff() resuppresses it:
        # written the week before a rule widened, so it still holds the name.
        name = invented.INDIVIDUALS[0][0]
        stored = invented.snapshot_row(vendor_display=name, vendor_key=name.lower())
        self.assertNotEqual(snapshot.resuppress(stored), stored,
                            "the premise: today's rules withhold this name")
        self.assert_no_name(repr(stored), "repr(SnapshotRow)")
        self.assert_no_name(repr(diff.Record([stored], [stored])), "repr(Record)")

    def test_an_event_for_a_name_the_rules_miss_prints_no_name(self):
        # The rules miss this name, so it is published with its key, and the
        # key is the name. It is right that it reaches the events table; it is
        # not right that it reaches a log.
        missed = invented.NAME_THE_RULES_MISS
        before_rows, _ = snapshot.build_snapshot(invented.pipeline_rows(
            [invented.source_row(vendor_name=missed)]), TODAY)
        after_rows, _ = snapshot.build_snapshot(invented.pipeline_rows(
            [invented.source_row(vendor_name=missed, end_date="2029-03-31")]), TODAY)
        events, _ = diff.diff(by_key(before_rows), {}, after_rows,
                              invented.published_of(after_rows), TODAY, base_run=7)
        self.assertEqual(len(events), 1)
        self.assertIn("VANTERPOOL", events[0].vendor_key.upper(), "the premise")
        self.assert_no_name(repr(events), "repr(Event)")
        self.assert_no_name(repr(after_rows), "repr(SnapshotRow)")


class BuyerNameNeverArrives(unittest.TestCase):
    """The field the source carries and ingest refuses to collect."""

    def setUp(self):
        snapshot.load_site_rules()

    def test_the_source_row_really_does_carry_it(self):
        # Without this the next case proves nothing: it would pass against a
        # fixture that never had a buyer name in it.
        self.assertIn("buyer_name", invented.source_row())

    def test_it_is_gone_by_the_time_a_pipeline_row_exists(self):
        rows = invented.pipeline_rows([invented.source_row()])
        self.assertNotIn("buyer_name", rows[0])
        self.assertNotIn("SOMEBODY", str(rows[0]).upper())

    def test_it_reaches_neither_a_snapshot_row_nor_an_event(self):
        before_rows = invented.pipeline_rows([invented.source_row()])
        after_rows = invented.pipeline_rows(
            [invented.source_row(end_date="2029-03-31")]
        )
        before, _ = snapshot.build_snapshot(before_rows, TODAY)
        after, _ = snapshot.build_snapshot(after_rows, TODAY)
        events, _ = diff.diff(by_key(before), {}, after, invented.published_of(after), TODAY, base_run=7)

        self.assertEqual(len(events), 1)
        # vars(), not str(): repr leaves the supplier fields out on purpose, so
        # str(events) could not see a buyer name that reached vendor_key.
        everything = (str([vars(r) for r in before + after])
                      + str([vars(e) for e in events])).upper()
        self.assertNotIn("BUYER_NAME", everything)
        self.assertNotIn("SOMEBODY", everything)


if __name__ == "__main__":
    unittest.main()
