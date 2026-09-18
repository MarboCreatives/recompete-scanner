"""The check that stops the vendor copies going stale. M2-DESIGN 4.2.

Nothing here reaches the network. check_drift is a pure function of two sets of
sources, so every case below hands it invented source text and reads the answer.
The one thing that cannot be tested without the network — that the real copies
match the real site today — is `py drift.py`, which is run by hand before a
merge and by the workflow before every scan.

The cases come in two halves, and the second half is the one that keeps this
check alive. A drift check that refuses on a rewritten comment gets switched
off, and a switched-off check is worse than none because everybody believes it
is running. So there are as many cases proving it stays QUIET as proving it
fires.
"""

from __future__ import annotations

import os
import unittest

import drift

VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")

# A miniature stand-in for the site's file. Everything the real one has that
# matters to the comparison: a word list built by splitting a string, a set
# literal, a plain constant, a function with a docstring.
SITE = '''
"""A pretend build_site."""

PERSON_LABEL = "Individual supplier (name withheld)"

CORP_WORDS = frozenset("""
INC LTD LIMITED
CORP COMPANY
""".split())

PLACEHOLDER_CATEGORY_NAMES = {"na", "nil", "none"}


def is_individual(name: str) -> bool:
    """True when a published vendor name is a private person."""
    n = (name or "").strip()
    if not n or any(ch.isdigit() for ch in n):
        return False
    return n.count(",") == 1
'''

WATCHED = (
    ("names.py", "build_site.py", drift.VALUE, "PERSON_LABEL"),
    ("names.py", "build_site.py", drift.WORDS, "CORP_WORDS"),
    ("names.py", "build_site.py", drift.WORDS, "PLACEHOLDER_CATEGORY_NAMES"),
    ("names.py", "build_site.py", drift.TREE, "is_individual"),
)


def check(vendor_text, site_text=SITE, data=()):
    return drift.check_drift(
        {"build_site.py": site_text},
        {"names.py": vendor_text},
        watched=WATCHED,
        watched_data=data,
    )


class ItStaysQuiet(unittest.TestCase):
    """The half that stops this check being switched off."""

    def test_an_identical_copy_reports_nothing(self):
        self.assertEqual(check(SITE), [])

    def test_a_rewritten_comment_is_not_a_rule_change(self):
        copy = SITE.replace(
            'PERSON_LABEL = "Individual supplier (name withheld)"',
            "# Added 14 September after six names reached print.\n"
            'PERSON_LABEL = "Individual supplier (name withheld)"',
        )
        self.assertEqual(check(copy), [])

    def test_a_corrected_docstring_is_not_a_rule_change(self):
        copy = SITE.replace(
            '"""True when a published vendor name is a private person."""',
            '"""True when a published vendor name is a private person.\n\n'
            "    Two rules, both measured against the full live vendor list.\n"
            '    """',
        )
        self.assertEqual(check(copy), [])

    def test_a_rewrapped_word_list_is_not_a_rule_change(self):
        # CORP_WORDS is one long triple-quoted string split on whitespace, so
        # re-wrapping it changes the literal and changes no rule. Comparing the
        # text here would refuse the run for a line break.
        copy = SITE.replace(
            'CORP_WORDS = frozenset("""\nINC LTD LIMITED\nCORP COMPANY\n""".split())',
            'CORP_WORDS = frozenset("""INC LTD\nLIMITED CORP\nCOMPANY""".split())',
        )
        self.assertEqual(check(copy), [])

    def test_a_reordered_set_literal_is_not_a_rule_change(self):
        copy = SITE.replace(
            'PLACEHOLDER_CATEGORY_NAMES = {"na", "nil", "none"}',
            'PLACEHOLDER_CATEGORY_NAMES = {"none", "na", "nil"}',
        )
        self.assertEqual(check(copy), [])

    def test_reindented_code_is_not_a_rule_change(self):
        copy = SITE.replace(
            '    if not n or any(ch.isdigit() for ch in n):\n        return False',
            '    if not n or any(\n        ch.isdigit() for ch in n\n    ):\n        return False',
        )
        self.assertEqual(check(copy), [])


class ItRefuses(unittest.TestCase):
    def test_one_word_changed_in_a_word_list(self):
        # The case the brief names. A single word is the whole difference
        # between a company being published and being withheld.
        copy = SITE.replace("INC LTD LIMITED", "INC LTD LIMITEE")
        found = check(copy)

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].symbol, "CORP_WORDS")
        self.assertIn("1 word(s) here are not on the site", found[0].detail)
        self.assertIn("1 on the site are not here", found[0].detail)

    def test_one_word_added_to_a_word_list(self):
        copy = SITE.replace("CORP COMPANY", "CORP COMPANY COOPERATIVE")
        found = check(copy)
        self.assertEqual([d.symbol for d in found], ["CORP_WORDS"])

    def test_one_word_removed_from_a_word_list(self):
        copy = SITE.replace("INC LTD LIMITED", "INC LTD")
        found = check(copy)
        self.assertEqual([d.symbol for d in found], ["CORP_WORDS"])

    def test_the_withheld_label_reworded(self):
        copy = SITE.replace(
            "Individual supplier (name withheld)", "Individual supplier (withheld)"
        )
        found = check(copy)
        self.assertEqual([d.symbol for d in found], ["PERSON_LABEL"])

    def test_a_rule_narrowed_by_one_condition(self):
        # The shape of site PR #19's fault: a rule that still looks right and
        # catches fewer people.
        copy = SITE.replace('return n.count(",") == 1', 'return n.count(",") == 2')
        found = check(copy)
        self.assertEqual([d.symbol for d in found], ["is_individual"])
        self.assertIn("docstrings aside", found[0].detail)

    def test_a_rule_that_vanished_from_the_site(self):
        site = SITE.replace("def is_individual", "def is_private_person")
        found = check(SITE, site_text=site)
        self.assertEqual([d.symbol for d in found], ["is_individual"])
        self.assertIn("gone from the site", found[0].detail)

    def test_a_rule_that_was_never_copied(self):
        copy = SITE.replace("def is_individual", "def something_else")
        found = check(copy)
        self.assertEqual([d.symbol for d in found], ["is_individual"])
        self.assertIn("not copied", found[0].detail)

    def test_a_file_that_could_not_be_read(self):
        found = drift.check_drift({}, {"names.py": SITE}, watched=WATCHED, watched_data=())
        self.assertEqual(len(found), len(WATCHED))


class ARuleChangedAfterItsDefinitionRefuses(unittest.TestCase):
    """Review, late round one #9 and #10.

    Python runs the LAST binding of a name. The first version compared only the
    first definition, so any of these, on either side, changed the effective
    rule while check_drift returned nothing. `|=` is the natural way to extend a
    frozenset, and extending GIVEN_NAMES is exactly what site PR #19 did.
    """

    SHAPES = (
        ('CORP_WORDS |= frozenset("EXTRA".split())', "CORP_WORDS"),
        ('CORP_WORDS -= {"INC"}', "CORP_WORDS"),
        ("CORP_WORDS = _SPARE = frozenset()", "CORP_WORDS"),
        ("CORP_WORDS, _SPARE = frozenset(), 1", "CORP_WORDS"),
        ("from elsewhere import is_individual", "is_individual"),
        ('PLACEHOLDER_CATEGORY_NAMES.add("general")', "PLACEHOLDER_CATEGORY_NAMES"),
        ("del CORP_WORDS", "CORP_WORDS"),
        ("def widen():\n    global CORP_WORDS\n    CORP_WORDS = frozenset()", "CORP_WORDS"),
        ("def is_individual(name):\n    return False", "is_individual"),
    )

    def test_each_shape_refuses_when_the_site_does_it(self):
        for statement, symbol in self.SHAPES:
            with self.subTest(statement=statement):
                found = check(SITE, site_text=SITE + "\n" + statement + "\n")
                self.assertEqual([d.symbol for d in found], [symbol])
                self.assertIn("cannot compare", found[0].detail)

    def test_each_shape_refuses_when_the_copy_does_it(self):
        # The vendor side matters as much: one appended CORP_WORDS |= {...}
        # here published a name the site withholds while every test passed.
        for statement, symbol in self.SHAPES:
            with self.subTest(statement=statement):
                found = check(SITE + "\n" + statement + "\n")
                self.assertEqual([d.symbol for d in found], [symbol])

    def test_a_local_that_shares_a_name_is_not_a_change(self):
        # Inside a function, a plain assignment binds a LOCAL. ingest.Contract
        # really does have a field called vendor_key, which is not the function
        # vendor_key. Refusing on that would refuse every run.
        local = "def helper():\n    CORP_WORDS = 1\n    return CORP_WORDS"
        self.assertEqual(check(SITE, site_text=SITE + "\n" + local + "\n"), [])

    def test_the_sites_own_loader_in_main_is_allowed(self):
        # build_site.main() fills VENDOR_ALLOWLIST from its data file, exactly
        # as snapshot.load_site_rules does here. That is not a rule change;
        # the file it reads is compared line by line in WATCHED_DATA.
        base = "VENDOR_ALLOWLIST: set[str] = set()\n"
        loader = "def main():\n    global VENDOR_ALLOWLIST\n    VENDOR_ALLOWLIST = load()\n"
        watched = (("names.py", "build_site.py", drift.TREE, "VENDOR_ALLOWLIST"),)
        found = drift.check_drift({"build_site.py": base + loader}, {"names.py": base},
                                  watched=watched, watched_data=())
        self.assertEqual(found, [])

    def test_the_same_loader_anywhere_else_is_not(self):
        base = "VENDOR_ALLOWLIST: set[str] = set()\n"
        loader = "def seed():\n    global VENDOR_ALLOWLIST\n    VENDOR_ALLOWLIST = {'x'}\n"
        watched = (("names.py", "build_site.py", drift.TREE, "VENDOR_ALLOWLIST"),)
        found = drift.check_drift({"build_site.py": base + loader}, {"names.py": base},
                                  watched=watched, watched_data=())
        self.assertEqual([d.symbol for d in found], ["VENDOR_ALLOWLIST"])

    def test_a_split_with_a_separator_cannot_be_read(self):
        # .split("\n") builds a different set from the same string. A bare
        # .split() on both sides computed the same words and passed.
        changed = SITE.replace('""".split())', '""".split("\\n"))')
        self.assertNotEqual(changed, SITE, "the premise: the edit must land")
        found = check(SITE, site_text=changed)
        self.assertEqual([d.symbol for d in found], ["CORP_WORDS"])
        self.assertIn("cannot be read", found[0].detail)


class DataFiles(unittest.TestCase):
    ALLOW = "# A comment\nRAYMOND CHABOT GRANT THORNTON\nSTEWART MCKELVEY\n"

    def check_data(self, ours, theirs):
        return drift.check_drift(
            {"vendor_allowlist.txt": theirs},
            {"vendor_allowlist.txt": ours},
            watched=(),
            watched_data=(("vendor_allowlist.txt", "vendor_allowlist.txt"),),
        )

    def test_a_rewritten_comment_is_not_a_change(self):
        theirs = "# Quite a different comment\n\nRAYMOND CHABOT GRANT THORNTON\nSTEWART MCKELVEY\n"
        self.assertEqual(self.check_data(self.ALLOW, theirs), [])

    def test_an_entry_added_on_the_site_refuses(self):
        theirs = self.ALLOW + "RENE BLAIS LTE\n"
        found = self.check_data(self.ALLOW, theirs)
        self.assertEqual(len(found), 1)
        self.assertIn("2 entries here against 3 on the site", found[0].detail)

    def test_an_entry_added_here_refuses(self):
        # This direction matters more. An entry added HERE and not on the site
        # is a name this repository has decided to publish that the site still
        # withholds, which is the wrong way round for it to be decided.
        found = self.check_data(self.ALLOW + "DANA QUILLERAN\n", self.ALLOW)
        self.assertEqual(len(found), 1)
        self.assertIn("1 here are not there", found[0].detail)


class ItNeverPrintsAWord(unittest.TestCase):
    """M2-DESIGN 4.2: the message names the file and the commit, never a name."""

    def test_no_word_from_either_list_reaches_the_difference(self):
        # GIVEN_NAMES is a list of given names. "trevor was added" is a given
        # name in a public Actions log, so the detail carries counts only.
        copy = SITE.replace("INC LTD LIMITED", "INC LTD QUILLERAN")
        found = check(copy)

        self.assertEqual(len(found), 1)
        text = f"{found[0].where} {found[0].symbol} {found[0].detail}".upper()
        self.assertNotIn("QUILLERAN", text)
        self.assertNotIn("LIMITED", text)
        self.assertNotIn("INC", text)

    def test_no_entry_from_a_data_file_reaches_the_difference(self):
        found = DataFiles().check_data(
            "DANA QUILLERAN\n", "RAYMOND CHABOT GRANT THORNTON\n"
        )
        self.assertEqual(len(found), 1)
        text = f"{found[0].where} {found[0].symbol} {found[0].detail}".upper()
        self.assertNotIn("QUILLERAN", text)
        self.assertNotIn("CHABOT", text)


class EveryCopiedRuleIsWatched(unittest.TestCase):
    """A rule copied and then not watched can go stale in silence."""

    def test_names_and_categories_have_nothing_unwatched(self):
        for filename in ("names.py", "categories.py"):
            with self.subTest(filename=filename):
                with open(os.path.join(VENDOR, filename), encoding="utf-8") as fh:
                    unwatched = drift.unwatched_definitions(fh.read(), filename)
                self.assertEqual(
                    unwatched, [],
                    f"{filename} defines {unwatched}, which drift.py does not check. "
                    "Add it to WATCHED, or to UNWATCHED_BY_DESIGN with the reason.",
                )

    def test_everything_unwatched_in_the_ingest_copy_has_a_written_reason(self):
        # The ingest copy is the whole site file, so some of it genuinely is not
        # a rule the scanner follows. Each one is named with why, rather than
        # the whole file being waved through.
        with open(os.path.join(VENDOR, "ingest.py"), encoding="utf-8") as fh:
            unwatched = drift.unwatched_definitions(fh.read(), "ingest.py")

        undocumented = [n for n in unwatched if n not in drift.UNWATCHED_BY_DESIGN]
        self.assertEqual(
            undocumented, [],
            f"{undocumented} is copied and neither watched nor explained.",
        )

    def test_the_scanners_own_addition_is_not_looked_for_on_the_site(self):
        # collect_refs does not exist on the site. Watching it would produce a
        # refusal nothing could ever clear.
        self.assertIn("collect_refs", drift.SCANNER_ADDITIONS)
        self.assertNotIn("collect_refs", [s for _, _, _, s in drift.WATCHED])


if __name__ == "__main__":
    unittest.main()
