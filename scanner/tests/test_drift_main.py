"""drift.main() end to end, with the network replaced. M2-DESIGN 4.2.

main() promises three exit codes: 0 the copies match, 1 they differ, 2 the site
could not be read. 1 and 2 both refuse the run; the difference is what a person
does next (a pull request, or a retry). Python exits 1 on an uncaught
exception, so a traceback out of main() is indistinguishable from "differs" at
the command line, and an exception for an in-process caller.

drift._get is the only function that touches the network. Every case replaces
it, and urllib's urlopen is replaced with one that fails the test, so nothing
here can reach GitHub. The "site" is built from the vendor copies themselves,
so the exit-0 case needs no real site file and every word in play is one the
repository already holds. The one word swapped in is invented.
"""

from __future__ import annotations

import ast
import http.client
import io
import json
import os
import re
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout

import drift

VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")
SHA = "0123456789abcdef0123456789abcdef01234567"   # invented
INVENTED_WORD = "ZZQINVENTEDWORD"
PROXY_PAGE = b"<html><body>Proxy</body></html>"


def _vendor_bytes(name: str) -> bytes:
    with open(os.path.join(VENDOR, name), "rb") as fh:
        return fh.read()


def site_from_vendor() -> dict[str, bytes]:
    """The site's four files, rebuilt from the copies: what 'no drift' serves."""
    return {
        "build_site.py": _vendor_bytes("names.py") + b"\n" + _vendor_bytes("categories.py"),
        "ingest.py": _vendor_bytes("ingest.py"),
        "vendor_allowlist.txt": _vendor_bytes("vendor_allowlist.txt"),
        "category_merges.txt": _vendor_bytes("category_merges.txt"),
    }


def one_word_swapped(source: bytes, symbol: str) -> tuple[bytes, str]:
    """`source` with the first word of `symbol`'s word list replaced by an
    invented one, and the word that was replaced. The word is found, never
    written out here."""
    text = source.decode("utf-8")
    node = next(n for n in ast.parse(text).body
                if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == symbol)
    segment = ast.get_source_segment(text, node)
    literal = node.value.args[0].func.value.value     # frozenset("""...""".split())
    first = sorted(literal.split())[0]
    swapped, n = re.subn(rf"(?<=\s){re.escape(first)}(?=\s)", INVENTED_WORD, segment, count=1)
    assert n == 1, "the premise: exactly one word was swapped"
    return text.replace(segment, swapped, 1).encode("utf-8"), first


def replace_definition(source: bytes, name: str, new_def: str) -> bytes:
    text = source.decode("utf-8")
    node = next(n for n in ast.parse(text).body
                if isinstance(n, ast.FunctionDef) and n.name == name)
    return text.replace(ast.get_source_segment(text, node), new_def, 1).encode("utf-8")


class FakeGitHub:
    """Stands in for drift._get. Serves the head sha and the site's files by
    name; a value that is an exception is raised instead."""

    def __init__(self, files=None, head=None):
        self.files = site_from_vendor() if files is None else files
        self.head = json.dumps({"sha": SHA}).encode() if head is None else head
        self.urls: list[str] = []

    def __call__(self, url: str, timeout: int) -> bytes:
        self.urls.append(url)
        if url.startswith("https://api.github.com/"):
            body = self.head
        else:
            body = self.files[url.rsplit("/", 1)[-1]]
        if isinstance(body, BaseException):
            raise body
        return body


class MainExitCodes(unittest.TestCase):

    def setUp(self):
        self._saved = (drift._get, urllib.request.urlopen)

        def no_network(*a, **k):
            raise AssertionError("a test reached for the real network")

        urllib.request.urlopen = no_network

    def tearDown(self):
        drift._get, urllib.request.urlopen = self._saved

    def run_main(self, fake: FakeGitHub):
        """(exit code, stdout, stderr). An exception escaping main() errors the
        test: that is the defect under test, not a harness failure."""
        drift._get = fake
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = drift.main()
        return code, out.getvalue(), err.getvalue()

    # ---- 0 -------------------------------------------------------------

    def test_exit_0_when_the_site_is_the_vendor_copies(self):
        fake = FakeGitHub()
        code, out, err = self.run_main(fake)
        self.assertEqual(code, 0, err)
        self.assertIn(SHA[:7], out)
        # Every file fetched at the head sha, never at the moving branch.
        files = [u for u in fake.urls if not u.startswith("https://api.github.com/")]
        self.assertEqual(len(files), 4)
        for u in files:
            self.assertIn(f"/{SHA}/", u)

    # ---- 1 -------------------------------------------------------------

    def test_exit_1_when_one_word_differs_and_the_word_is_not_printed(self):
        files = site_from_vendor()
        files["build_site.py"], replaced = one_word_swapped(files["build_site.py"], "CORP_WORDS")
        code, out, err = self.run_main(FakeGitHub(files))
        self.assertEqual(code, 1)
        self.assertIn("CORP_WORDS", err)
        self.assertIn("1 word(s) here are not on the site, 1 on the site are not here", err)
        # Neither side's word: not the site's, and not the copy's it replaced.
        for word in (INVENTED_WORD, replaced):
            self.assertNotRegex(out + err, r"\b" + re.escape(word) + r"\b", "a word from a list reached the log")

    # ---- 2 -------------------------------------------------------------

    def test_exit_2_when_the_network_fails(self):
        for label, fake in (
            ("head", FakeGitHub(head=urllib.error.URLError("invented"))),
            ("file", FakeGitHub({**site_from_vendor(),
                                 "ingest.py": urllib.error.URLError("invented")})),
        ):
            with self.subTest(label):
                self.assertEqual(self.run_main(fake)[0], 2)

    def test_exit_2_when_a_proxy_page_arrives_instead_of_python(self):
        for name in ("build_site.py", "ingest.py"):
            with self.subTest(name):
                files = {**site_from_vendor(), name: PROXY_PAGE}
                code, _, err = self.run_main(FakeGitHub(files))
                self.assertEqual(code, 2, err)
        with self.subTest("head"):
            self.assertEqual(self.run_main(FakeGitHub(head=PROXY_PAGE))[0], 2)

    def test_exit_0_when_a_site_file_starts_with_a_byte_order_mark(self):
        # Some Windows editors write one. Python reads such a file normally, so
        # drift must too, or every weekly run refuses until someone notices.
        files = site_from_vendor()
        files["build_site.py"] = b"\xef\xbb\xbf" + files["build_site.py"]
        code, _, err = self.run_main(FakeGitHub(files))
        self.assertEqual(code, 0, err)

    def test_exit_0_when_the_head_is_a_sha_256_object_name(self):
        head = json.dumps({"sha": "0123456789abcdef" * 4}).encode()
        code, _, err = self.run_main(FakeGitHub(head=head))
        self.assertEqual(code, 0, err)

    def test_exit_2_when_the_vendor_copies_cannot_be_read(self):
        # The one branch a fake _get cannot reach. read_vendor_sources is
        # replaced, not drift.VENDOR: that is bound as a default argument.
        saved = drift.read_vendor_sources

        def gone(*a, **k):
            raise FileNotFoundError("invented")

        drift.read_vendor_sources = gone
        try:
            self.assertEqual(self.run_main(FakeGitHub())[0], 2)
        finally:
            drift.read_vendor_sources = saved

    def test_exit_2_when_the_head_is_not_a_sha(self):
        # The files are served perfectly, so only the sha check can refuse.
        for head in (b'{"sha": "not-a-sha"}', b'{"sha": "main"}', b'{"sha": 12345}',
                     b"[]", b"null", b"{}", b""):
            with self.subTest(head=head):
                self.assertEqual(self.run_main(FakeGitHub(head=head))[0], 2)

    def test_exit_2_when_a_body_is_cut_short(self):
        # What urllib raises when a 200 stops before its Content-Length.
        whole = site_from_vendor()["build_site.py"]
        cut = http.client.IncompleteRead(whole[:100], len(whole) - 100)
        files = {**site_from_vendor(), "build_site.py": cut}
        self.assertEqual(self.run_main(FakeGitHub(files))[0], 2)

    def test_exit_2_when_a_body_is_cut_mid_statement(self):
        whole = site_from_vendor()["build_site.py"]
        files = {**site_from_vendor(), "build_site.py": whole[: len(whole) // 2]}
        self.assertEqual(self.run_main(FakeGitHub(files))[0], 2)

    def test_exit_2_when_the_status_line_is_garbled(self):
        files = {**site_from_vendor(), "ingest.py": http.client.BadStatusLine("invented")}
        self.assertEqual(self.run_main(FakeGitHub(files))[0], 2)

    def test_exit_2_when_a_body_is_not_utf8(self):
        files = {**site_from_vendor(), "build_site.py": b"\xff\xfe\xfa invented"}
        self.assertEqual(self.run_main(FakeGitHub(files))[0], 2)

    def test_exit_2_when_python_is_nested_deeper_than_can_be_compared(self):
        deep = "+".join(["1"] * 600)
        site = site_from_vendor()["build_site.py"]
        for label, body in (
            # ast.parse itself gives up
            ("parse", site + b"\nZZ_INVENTED = " + "+".join(["1"] * 3000).encode() + b"\n"),
            # parses, then ast.unparse in _strip_docstrings gives up
            ("compare", replace_definition(site, "is_individual",
                                           f"def is_individual(name):\n    return {deep}\n")),
        ):
            with self.subTest(label):
                files = {**site_from_vendor(), "build_site.py": body}
                self.assertEqual(self.run_main(FakeGitHub(files))[0], 2)


if __name__ == "__main__":
    unittest.main()
