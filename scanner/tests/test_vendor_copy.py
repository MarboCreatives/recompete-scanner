"""What the copied files may and may not carry. Review, 17 September 2026.

The first copy of vendor/names.py carried three real sole traders' names, quoted
as examples in the site's own is_individual docstring. The rules in that same
file withhold all three. It was pushed to this public repository before a
review caught it; the branch was rewritten to remove it. CODING-STANDARDS 3:
never write a withheld name anywhere — and a re-copy from the site, which is how
vendor/ is meant to be kept current, would bring them straight back. So this
checks every file the scanner commits (.py, .md and .txt), not only the one
where they were found.

The oracle is the site's own rule, deliberately. The question is exactly "would
the rules this repository enforces withhold this string as a person", and the
answer to that question is is_individual. What it cannot catch — a name the
rules miss — is recorded in test_suppression and is the display path's job.
"""

from __future__ import annotations

import ast
import hashlib
import io
import os
import re
import tokenize
import unittest

import snapshot
from tests import invented
from vendor import names

# Absent before Python 3.12, when an f-string was one STRING token.
FSTRING_MIDDLE = getattr(tokenize, "FSTRING_MIDDLE", object())

SCANNER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Strings the rules read as a person but which are not anybody:
#   "SURNAME, Given"      is_individual's own docstring naming the shape of rule 1
#   "SOMEBODY, Invented"  the invented buyer_name in tests/invented.source_row
# Every invented supplier name is allowed too, from tests/invented.py.
NOT_ANYBODY = {"surname, given", "somebody, invented"}

# Double quotes only. In prose an apostrophe is not a quotation mark, and the
# first version treated it as one: "The site's copy ... such as "DANA X"" paired
# the apostrophe in site's with the opening quote of the name and swallowed it.
# The break harness found that by quoting an invented name next to an
# apostrophe; the site's real docstring has "Rule 2's" right beside the three
# real names. A single-quoted Python string is still checked, because
# pieces() offers every string literal's own value as a candidate too.
QUOTED = re.compile(r"\"([^\"\n]{4,80})\"")


# Every kind of file the scanner commits. Round three, 18 September 2026: the
# first version opened .py files only, so a name quoted in README.md, or in a
# comment of vendor_allowlist.txt, which is re-copied from the site, passed.
COMMITTED_TEXT = (".py", ".md", ".txt")


def committed_files():
    for root, dirs, files in os.walk(SCANNER):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            if name.endswith(COMMITTED_TEXT):
                yield os.path.join(root, name)


def literal_parts(token_text):
    """The text of one STRING token: its value, or an f-string's literal parts.

    On Python 3.12 and later an f-string arrives as FSTRING_MIDDLE tokens, and
    pieces() reads those. Before 3.12, which M2-DESIGN 9 says the weekly
    workflow runs, an f-string is ONE STRING token, literal_eval refuses it,
    and the first version of this guard skipped it: on 3.11 a name in an
    f-string passed, and test_the_check_can_see_a_name_in_an_f_string failed on
    a correct tree. ast.parse reads an f-string on every version; its Constant
    parts are the text between the placeholders. Review of the fixes,
    18 September 2026.
    """
    try:
        value = ast.literal_eval(token_text)
    except (ValueError, SyntaxError):
        try:
            node = ast.parse(token_text.strip(), mode="eval").body
        except SyntaxError:
            return []
        if not isinstance(node, ast.JoinedStr):
            return []
        return [c.value for c in ast.walk(node)
                if isinstance(c, ast.Constant) and isinstance(c.value, str)]
    return [value] if isinstance(value, str) else []


class NoWithheldNameIsCommitted(unittest.TestCase):
    def setUp(self):
        snapshot.load_site_rules()
        self.invented = {names._norm_name(n) for n in invented.ALL_INVENTED_NAMES}

    def person_shaped(self, text):
        """Quoted strings the rules would withhold, after whitespace is joined.

        Joined because a docstring wraps a long name across two lines, and a
        search one line at a time found only one of the three.
        """
        flat = " ".join(text.split())
        out = []
        for q in QUOTED.findall(flat):
            # A written \n inside a Python string literal is not part of a name.
            q = q.replace("\\n", " ").strip()
            # Only strings shaped like a supplier name are candidates: no
            # braces, and every word capitalised, as vendor_name is in the
            # source. The first run of this check flagged format strings with
            # one comma ("{counts.matched:,} in both") and prose that uses a
            # given name as a word ("trevor was added"). Neither is anybody,
            # and a check that cries wolf on its own repository gets switched
            # off. The three real names that started this were all capitals.
            if "{" in q or "}" in q:
                continue
            words = names._name_tokens(q)
            if not words or not all(w[0].isupper() for w in words):
                continue
            n = names._norm_name(q)
            if n in NOT_ANYBODY or n in self.invented or n in names.VENDOR_ALLOWLIST:
                continue
            if names.is_individual(q):
                out.append(q)
        return out

    def pieces(self, source):
        """Each string literal and each comment in a Python file, separately.

        Read with Python's own tokenizer, one piece at a time, so a quote can
        never pair with a quote in a DIFFERENT piece. The first version ran
        one regex over the whole flattened file, and paired the closing quote
        of one string with the opening quote of the next, catching the code
        between them: `NAME, KEY =` has one comma, so it read as a person.
        """
        out = []
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                out.append(tok.string)
            elif tok.type == FSTRING_MIDDLE:
                # The literal text of an f-string, between its placeholders.
                # From Python 3.12 an f-string is not one STRING token, and
                # before it literal_eval refuses one, so either way the first
                # version never looked inside an f-string. Round three,
                # 18 September 2026.
                out.append(f'"{tok.string}"')
                out.append(tok.string)
            elif tok.type == tokenize.STRING:
                for value in literal_parts(tok.string):
                    # The literal itself, and anything quoted inside it: the
                    # three real names were quoted inside a docstring.
                    out.append(f'"{value}"')
                    out.append(value)
        return out

    def found_in(self, path, text):
        # A Python file is read piece by piece (see pieces); any other file is
        # prose, read whole.
        parts = self.pieces(text) if path.endswith(".py") else [text]
        return [q for piece in parts for q in self.person_shaped(piece)]

    def test_no_file_the_scanner_commits_quotes_a_withheld_name(self):
        checked = 0
        kinds = set()
        for path in committed_files():
            checked += 1
            kinds.add(os.path.splitext(path)[1])
            with open(path, encoding="utf-8") as fh:
                found = self.found_in(path, fh.read())
            with self.subTest(file=os.path.relpath(path, SCANNER)):
                # The count, never the strings: a failure message is output too.
                self.assertEqual(
                    len(found), 0,
                    f"{len(found)} quoted string(s) the rules withhold as a person",
                )
        self.assertGreater(checked, 8, "the walk must actually reach the files")
        # Written out, not taken from COMMITTED_TEXT: compared with the
        # constant that drives the walk, narrowing both passed.
        self.assertEqual(kinds, {".py", ".md", ".txt"}, "every kind of committed file is read")

    # Invented, withheld by rule 2, and on no fixture list. Joined at run time:
    # written out whole and quoted here, it would fail the walk above.
    PROBE = " ".join(("DANA", "SMALLWOOD"))

    def test_the_check_can_see_a_name_in_an_f_string(self):
        source = (
            "x = 1\n"
            f'message = f"{{x}} for \\"{self.PROBE}\\""\n'
            f'plain = f"{self.PROBE}"\n'
        )
        self.assertEqual(len(self.found_in("probe.py", source)), 2)

    def test_an_f_string_read_as_one_token_is_still_read(self):
        # How Python 3.11 hands an f-string over: one STRING token, which
        # literal_eval refuses. This interpreter tokenizes f-strings in parts,
        # so the 3.11 path is exercised here through literal_parts directly;
        # it has not been run on a 3.11 interpreter.
        for token in (f'f"{{x}} for \\"{self.PROBE}\\""', f'f"{self.PROBE}"',
                      f"rf'{{x!r:>10}} {self.PROBE}'"):
            with self.subTest(token=token):
                parts = literal_parts(token)
                self.assertTrue(parts, "an f-string token gave no text")
                found = [q for part in parts for q in (self.person_shaped(f'"{part}"')
                                                        + self.person_shaped(part))]
                self.assertEqual(len(found), 1, parts)
        self.assertEqual(literal_parts('b"DANA"'), [], "bytes are not text")
        self.assertEqual(literal_parts("'plain'"), ["plain"])

    def test_the_check_can_see_a_name_quoted_in_prose(self):
        text = f'# A supplier list.\n# "{self.PROBE}" was removed.\nNORTHWIND WIDGETS INC\n'
        self.assertEqual(len(self.found_in("vendor_allowlist.txt", text)), 1)
        self.assertEqual(len(self.found_in("README.md", text)), 1)

    def test_the_check_can_see_a_name_that_wraps_across_lines(self):
        # The shape the original three had, built from invented words.
        text = '"TREVOR QUILLERAN PHOTOGRAPHIE\n       ARTISANALE", "x"'
        self.assertEqual(len(self.person_shaped(text.replace("TREVOR", "DANA"))), 1)

    def test_the_check_ignores_the_fixtures_and_the_watch_key_shape(self):
        self.assertEqual(self.person_shaped('"QUILLERAN, Marisol" "{org},{ref}"'), [])


class EveryVendorFileNamesItsSource(unittest.TestCase):
    """README: each file in vendor/ names the site commit it came from.

    Until 18 September 2026 the two data files did not (outside review, item
    13). Their header is five '#' lines, which the site's loaders and
    drift.data_lines both skip.
    """

    VENDOR = os.path.join(SCANNER, "vendor")
    COMMIT = re.compile(r"SITE COMMIT\s+([0-9a-f]{40})")
    SHA = re.compile(r"SOURCE FILE\s+SHA-256 ([0-9a-f]{64})")
    HEADER_LINES = 5

    def read(self, name):
        with open(os.path.join(self.VENDOR, name), encoding="utf-8", newline="") as fh:
            return fh.read()

    def test_each_copy_names_one_commit_and_a_hash(self):
        commits = set()
        copies = [n for n in sorted(os.listdir(self.VENDOR)) if n.endswith((".py", ".txt"))]
        self.assertEqual(len(copies), 5, "ingest, names, categories and the two data files")
        for name in copies:
            text = self.read(name)
            with self.subTest(file=name):
                c, s = self.COMMIT.search(text), self.SHA.search(text)
                self.assertIsNotNone(c, "names no site commit")
                self.assertIsNotNone(s, "names no SHA-256")
                commits.add(c.group(1))
        self.assertEqual(len(commits), 1, "every copy is from the same site commit")

    def test_a_data_file_is_the_site_file_under_its_header(self):
        # The recorded hash is of the site's file (measured against the site at
        # the named commit on 18 September 2026). Take the header off and the
        # rest must be that file byte for byte, so an edit made here fails even
        # in a comment, which drift.py ignores. Stable on Windows only because
        # .gitattributes checks these files out with LF endings.
        for name in ("vendor_allowlist.txt", "category_merges.txt"):
            lines = self.read(name).splitlines(keepends=True)
            head, body = lines[:self.HEADER_LINES], "".join(lines[self.HEADER_LINES:])
            with self.subTest(file=name):
                self.assertTrue(all(line.startswith("#") for line in head),
                                "a header line the loaders would read as an entry")
                recorded = self.SHA.search("".join(head)).group(1)
                self.assertEqual(hashlib.sha256(body.encode("utf-8")).hexdigest(), recorded)


class OnlyTheNamedRealOrganisationIsAFixture(unittest.TestCase):
    """Fixtures are invented (README; M2-DESIGN 4). tests/invented.py names ONE
    real allowlisted company, ALLOWLISTED_ORGANISATION, on purpose. No other
    real allowlist entry may appear in a test file: two did until 18 September
    2026 (outside review, item 13). The committed-name guard above cannot see
    them, because it skips allowlist entries by design. Counts only."""

    @staticmethod
    def uses(piece, entries):
        """True if a real allowlist entry appears in this piece.

        Whitespace joined, as person_shaped does: a docstring wraps a firm's
        name across two lines, and a search one line at a time missed it
        (review of the fixes, 18 September 2026). Still one literal at a
        time: a name split across adjacent literals is not seen, which is
        written down here rather than implied.
        """
        flat = " " + " ".join(re.findall(r"[\w&'.-]+", names._norm_name(piece))) + " "
        return any(f" {e} " in flat for e in entries)

    def test_a_real_entry_wrapped_across_a_docstring_line_is_seen(self):
        # Built at run time from the allowlist itself, so no real firm's name
        # is written into this file.
        snapshot.load_site_rules()
        sanctioned = names._norm_name(invented.ALLOWLISTED_ORGANISATION)
        entry = sorted(set(names.VENDOR_ALLOWLIST) - {sanctioned})[0]
        words = entry.upper().split()
        self.assertGreater(len(words), 1, "the premise: an entry of more than one word")
        wrapped = f"As used by {' '.join(words[:1])}\n        {' '.join(words[1:])} in this case."
        self.assertTrue(self.uses(wrapped, {entry}))
        self.assertFalse(self.uses("Northwind Widgets Inc", {entry}), "and not on invented text")

    def test_no_other_real_allowlist_entry_is_test_data(self):
        snapshot.load_site_rules()
        sanctioned = names._norm_name(invented.ALLOWLISTED_ORGANISATION)
        others = set(names.VENDOR_ALLOWLIST) - {sanctioned}
        self.assertTrue(others, "the premise: the allowlist holds other entries")
        guard = NoWithheldNameIsCommitted()
        tests_dir = os.path.dirname(os.path.abspath(__file__))
        hits = 0
        for name in sorted(os.listdir(tests_dir)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(tests_dir, name), encoding="utf-8") as fh:
                pieces = guard.pieces(fh.read())
            hits += sum(1 for piece in pieces if self.uses(piece, others))
        # A count of pieces, never the entries: a failure message is output too.
        # (A literal is offered twice, quoted and raw; a comment once.)
        self.assertEqual(hits, 0, f"a real allowlist entry is test data in {hits} piece(s)")


if __name__ == "__main__":
    unittest.main()
