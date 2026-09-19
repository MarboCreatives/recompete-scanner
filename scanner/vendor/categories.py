"""The site's category-key rules, copied. Do not edit to fix a scanner problem.

COPIED FROM  MarboCreatives/recompete-radar  build_site.py
SITE COMMIT  d09109f6abf2fda7ac287692f99e434ec4659ed6
SOURCE FILE  SHA-256 247a5ac859fce784fd0bc3ab7ca7f8665f1302377de6130ef306f4ce5a888c92
COPIED ON    17 September 2026

Same rules as vendor/names.py: lifted with ast.get_source_segment, checked by
drift.py before every scan, and re-copied rather than edited when the site
moves.

WHY THIS FILE EXISTS, when M2-DESIGN section 4 does not list it. Section 5.1
gives contract_snapshot a category_key column, section 6 puts category_key in
the NEW_AWARD payload, and section 11 has M3 reusing it. The value comes from
the site's add_category_key, which the design's file table does not mention
because the table only names the NAME rules. Three ways to close that:

  * leave category_key empty, which makes it a column nothing writes, and
    0001_init.sql's own header calls that "a lie in the schema";
  * compute it in snapshot.py, which is a second implementation of a site rule
    living outside the drift check, so it would go stale in silence;
  * copy it here, on the same terms as every other copied rule.

The third. Flagged to Jon on 17 September as a gap between M2-DESIGN 4 and 5.1
rather than decided quietly.

CATEGORY_MERGES IS A MODULE GLOBAL AND STARTS EMPTY, as on the site, where
build_site.main() fills it from category_merges.txt. Unloaded, keys are the
normalised name with no merging, so two spellings of one category would not
collapse. snapshot.py loads it and refuses to run if the file is missing.
"""

from __future__ import annotations

import os
import re


PLACEHOLDER_CATEGORY_NAMES = {
    "na", "nil", "none", "null", "nulle", "unknown", "unspecified",
    "notapplicable", "sansobjet", "tbd", "tobedetermined",
}


def is_placeholder_category(name: str) -> bool:
    """True when a category name carries no subject a reader could browse.

    Two rules, both written from faults that reached the live site:

    1. No letter anywhere. "#" is the case that prompted this. A name like that
       also slugs to an empty string, so it can only reach a URL through the
       fallback in slug() — which is how "#" became /category/x.html.
    2. A known placeholder word. "NA" and "N/A" are ordinary strings with
       letters in them, so rule 1 on its own leaves both of them published.

    Only the WHOLE name is tested, never a word inside it, so real categories
    such as "Other buildings" and "Rental - Other" are untouched. An empty name
    is NOT treated as a placeholder here: add_category_key already falls back to
    the commodity code for those rows, and that behaviour is left alone.
    """
    n = re.sub(r"\s+", " ", (name or "")).strip()
    if not n:
        return False
    if not any(ch.isalpha() for ch in n):
        return True
    return re.sub(r"[^a-z]", "", n.lower()) in PLACEHOLDER_CATEGORY_NAMES


CATEGORY_MERGES: dict[str, str] = {}


def category_norm(name: str) -> str:
    n = re.sub(r"\s+", " ", (name or "")).strip().lower()
    n = re.sub(r"^\d{3,5}\s*[-\u2013\u2014:]\s*", "", n)
    n = re.sub(r"\s*[-\u2013\u2014]\s*", "-", n)
    n = re.sub(r"\s*/\s*", "/", n)
    n = re.sub(r",\s*and\b", " and", n)
    return re.sub(r"\s+", " ", n).strip()


def load_category_merges(path: str) -> dict[str, str]:
    """`from => to`, one per line, # starts a comment. Both sides are passed
    through category_norm, so the file can be written in the source's own
    capitalisation. A chain or a loop is refused rather than guessed at."""
    out: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if "=>" not in line:
                raise ValueError(f"{path}:{i}: expected 'from => to'")
            a, b = (category_norm(x) for x in line.split("=>", 1))
            if not a or not b or a == b:
                raise ValueError(f"{path}:{i}: empty or self merge")
            if a in out:
                raise ValueError(f"{path}:{i}: {a!r} is merged twice")
            out[a] = b
    for a, b in out.items():
        if b in out:
            raise ValueError(f"{path}: {a!r} merges into {b!r}, which is itself merged")
    return out


def category_key_of(name: str) -> str:
    n = category_norm(name)
    return CATEGORY_MERGES.get(n, n)


def add_category_key(rows: list[dict]) -> None:
    """Collapse commodity codes onto their human name.

    The government issues many distinct commodity codes that carry the SAME
    description — 1,641 codes reduce to 313 real names. Grouping on the code
    fragments a single subject across dozens of near-identical pages: management
    consulting alone is $14.4B spread over 28 codes. Those pages compete with
    each other for one search term and each is individually weak.

    Grouping on the normalized name yields one strong page per subject.
    Normalization is case- and whitespace-insensitive, because the same
    description appears with inconsistent capitalisation
    ("Other Business services..." vs "Other business services...").

    A name that is only a placeholder gets no key at all. group() skips a row
    with an empty key, so those contracts get no category page and no category
    link, while staying fully visible under their department and incumbent.
    """
    for r in rows:
        name = (r.get("category_name") or "").strip()
        if is_placeholder_category(name):
            r["category_key"] = ""
            continue
        r["category_key"] = category_key_of(name) or (r.get("commodity_code") or "")
