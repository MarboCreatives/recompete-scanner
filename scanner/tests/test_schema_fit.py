"""The scanner's constants against the migrations that will store its output.

Migration 0004 spells out the withheld label and the four refusal codes as
literals, because a CHECK constraint cannot import a Python constant. Its own
comment promises that "scanner/tests asserts the two agree, so they cannot
drift apart silently". The first tests to make that promise compared the Python
constant with a THIRD copy typed into the test file, and never opened the
migration (review, late round one #8). Here is the realistic failure that let
through: the site renames its label, drift.py refuses the run, a routine re-copy
updates vendor/ and the test literals, the suite goes green — and every week's
transaction then rolls back on the first withheld individual, because the
migration still spells the old label.

So these read the SQL itself. They can, because this pull request is built on
PR A: the migration is in the same tree. If it is not there, that is a failure,
not a skip — a check that quietly does not run is the thing this project keeps
finding.
"""

from __future__ import annotations

import os
import re
import unittest

import diff
import snapshot
from vendor import names

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MIGRATIONS = os.path.join(REPO, "app", "db", "migrations")


def read_migration(name: str) -> str:
    path = os.path.join(MIGRATIONS, name)
    if not os.path.exists(path):
        raise AssertionError(
            f"{name} is not in {MIGRATIONS}. These checks pin the scanner to the "
            "schema it writes to, and must not pass without it."
        )
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def constraint(sql: str, name: str) -> str:
    """The text of one named CHECK constraint, up to the matching parenthesis."""
    start = sql.index(f"CONSTRAINT {name} CHECK (")
    i = sql.index("(", start)
    depth = 0
    for j in range(i, len(sql)):
        if sql[j] == "(":
            depth += 1
        elif sql[j] == ")":
            depth -= 1
            if depth == 0:
                return sql[i:j + 1]
    raise AssertionError(f"{name} is not closed")


def quoted(text: str) -> list[str]:
    return re.findall(r"'([^']*)'", text)


class TheScannerAndTheSchemaAgree(unittest.TestCase):
    def test_the_withheld_label_is_the_one_the_pairing_constraint_spells(self):
        check = constraint(read_migration("0004_scanner.sql"),
                           "contract_snapshot_withheld_pairing")
        self.assertEqual(quoted(check), ["", names.PERSON_LABEL])

    def test_the_refusal_codes_are_the_ones_scan_runs_accepts(self):
        check = constraint(read_migration("0004_scanner.sql"), "scan_runs_refusal_reason_check")
        self.assertEqual(
            sorted(quoted(check)),
            sorted([diff.REFUSAL_LIVE_COUNT_DROP, diff.REFUSAL_GONE_RATE,
                    diff.REFUSAL_DRIFT, diff.REFUSAL_SELF_TEST]),
        )

    def test_every_event_type_the_diff_emits_is_one_events_accepts(self):
        check = constraint(read_migration("0001_init.sql"), "events_type_check")
        self.assertTrue(set(diff.EVENT_TYPES) <= set(quoted(check)))

    def test_the_largest_amount_kept_is_the_largest_the_column_holds(self):
        # Round three, 18 September 2026: an amount the column cannot hold
        # rolled back the week. snapshot._as_float now refuses it, and its
        # limit is pinned here to the column's own declaration.
        found = re.findall(r"^\s*contract_value\s+numeric\((\d+),\s*(\d+)\)",
                           read_migration("0004_scanner.sql"), re.MULTILINE)
        self.assertEqual(len(found), 1, "contract_snapshot.contract_value must be declared once")
        precision, scale = (int(n) for n in found[0])
        self.assertEqual(snapshot.LARGEST_STORABLE_VALUE, 10 ** (precision - scale))

    def test_the_largest_amount_is_kept_and_the_next_cent_is_not(self):
        largest = 10 ** 14 - 0.01
        self.assertEqual(snapshot._as_float(largest), largest)
        self.assertEqual(snapshot._as_float(str(largest)), largest)
        for bad in ("1e14", "-1e14", "inf", "-Infinity", "nan", 1e300):
            with self.subTest(value=bad):
                self.assertIsNone(snapshot._as_float(bad))

    def test_the_check_can_tell_when_they_disagree(self):
        # The parsing above is the new part, so it is shown to see a
        # difference rather than trusted to.
        sql = ("CONSTRAINT contract_snapshot_withheld_pairing CHECK (\n"
               "  (vendor_key = '') = (vendor_display = 'Individual supplier (withheld)')\n)")
        self.assertNotEqual(quoted(constraint(sql, "contract_snapshot_withheld_pairing")),
                            ["", names.PERSON_LABEL])


if __name__ == "__main__":
    unittest.main()
