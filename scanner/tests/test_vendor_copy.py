"""What the copied files may and may not carry. Review, 17 September 2026.

The first copy of vendor/names.py carried three real sole traders' names, quoted
as examples in the site's own is_individual docstring. The rules in that same
file withhold all three. It was pushed to this public repository before a
review caught it; the branch was rewritten to remove it. CODING-STANDARDS 3:
never write a withheld name anywhere — and a re-copy from the site, which is how
vendor/ is meant to be kept current, would bring them straight back. So this
checks every file the scanner commits, not only the one where they were found.

The oracle is the site's own rule, deliberately. The question is exactly "would
the rules this repository enforces withhold this string as a person", and the
answer to that question is is_individual. What it cannot catch — a name the
rules miss — is recorded in test_suppression and is the display path's job.
"""

from __future__ import annotations

import ast
import io
import os
import re
import tokenize
import unittest

import snapshot
from tests import invented
from vendor import names

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


def committed_python_files():
    for root, dirs, files in os.walk(SCANNER):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(root, name)


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
            elif tok.type == tokenize.STRING:
                try:
                    value = ast.literal_eval(tok.string)
                except (ValueError, SyntaxError):
                    continue
                if isinstance(value, str):
                    # The literal itself, and anything quoted inside it: the
                    # three real names were quoted inside a docstring.
                    out.append(f'"{value}"')
                    out.append(value)
        return out

    def test_no_file_the_scanner_commits_quotes_a_withheld_name(self):
        checked = 0
        for path in committed_python_files():
            checked += 1
            with open(path, encoding="utf-8") as fh:
                found = [q for piece in self.pieces(fh.read())
                         for q in self.person_shaped(piece)]
            with self.subTest(file=os.path.relpath(path, SCANNER)):
                # The count, never the strings: a failure message is output too.
                self.assertEqual(
                    len(found), 0,
                    f"{len(found)} quoted string(s) the rules withhold as a person",
                )
        self.assertGreater(checked, 8, "the walk must actually reach the files")

    def test_the_check_can_see_a_name_that_wraps_across_lines(self):
        # The shape the original three had, built from invented words.
        text = '"TREVOR QUILLERAN PHOTOGRAPHIE\n       ARTISANALE", "x"'
        self.assertEqual(len(self.person_shaped(text.replace("TREVOR", "DANA"))), 1)

    def test_the_check_ignores_the_fixtures_and_the_watch_key_shape(self):
        self.assertEqual(self.person_shaped('"QUILLERAN, Marisol" "{org},{ref}"'), [])


if __name__ == "__main__":
    unittest.main()
