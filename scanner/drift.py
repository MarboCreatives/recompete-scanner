"""Refuses the run when scanner/vendor/ no longer matches the site.

M2-DESIGN 4.2. This runs first in every scan, before anything is written.

WHY IT EXISTS RATHER THAN BEING A PRECAUTION. The site's name rules changed in
September, in site PR #19: GIVEN_NAMES was extended, NAME_PARTICLES and
TITLE_WORDS were added, and is_individual grew a third rule. Six names had
already reached print. A copy of those rules that quietly stayed on the old
version would publish, every Monday, names the site now withholds. So the
scanner refuses to run rather than run on a stale copy. Fail closed: a missed
week of events costs a reader a week. A published name cannot be taken back.

WHY IT PARSES RATHER THAN COMPARING TEXT. Two reasons, and the second is the
one that makes text comparison useless here. First, the site's file is 124,000
bytes and the scanner copies fourteen definitions out of it, so there is no
text to compare against. Second, a comment rewritten, a line re-wrapped or a
docstring corrected would all fail a text comparison while changing no rule at
all, and a check that cries wolf gets switched off. This project has already
watched that happen once, to an allowlist alarm that fired on a correct list.

WHAT IS COMPARED, AND HOW

  functions and classes  the syntax tree, with docstrings removed. Comments and
                         layout are not in the tree, so they cannot cause a
                         false refusal. A changed default, a changed operator, a
                         reordered condition all can and should.

  word lists             the SET OF WORDS, not the literal. CORP_WORDS is one
                         long triple-quoted string that is split on whitespace,
                         so re-wrapping it changes the literal and changes
                         nothing else. Comparing the words is comparing the rule.

  plain constants        the value.

  data files             the lines, after the site's own comment and whitespace
                         handling, because that is what its loader sees.

WHAT THE FAILURE MESSAGE MAY SAY. The file, the symbol and the site commit.
NEVER a word from either side: GIVEN_NAMES is a list of given names, and
printing "trevor was added" prints a given name into a public Actions log. So
the message counts the differences and stops there. M2-DESIGN 4.2 and 7.

The comparison is a pure function of two sets of sources. Only fetch_site_file
and site_head_sha touch the network, so the tests drive check_drift with
invented sources and never reach GitHub.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable, Optional

SITE_REPO = "MarboCreatives/recompete-radar"
SITE_BRANCH = "main"
USER_AGENT = "recompete-scanner/1.0 (drift check)"

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")


# --------------------------------------------------------------------------
# What is watched
# --------------------------------------------------------------------------
#
# Adding a rule to vendor/ without adding it here gives a copy nothing checks,
# which is the exact failure this module exists to prevent. tests/test_drift.py
# asserts every top-level definition in vendor/names.py and vendor/categories.py
# appears below, so that omission fails the suite rather than going unnoticed.

TREE = "tree"          # compare the syntax tree, docstrings removed
WORDS = "words"        # compare the set of words
VALUE = "value"        # compare the constant's value

WATCHED: tuple[tuple[str, str, str, str], ...] = (
    # (vendor file, site file, kind, symbol)
    ("names.py", "build_site.py", VALUE, "PERSON_LABEL"),
    ("names.py", "build_site.py", WORDS, "CORP_WORDS"),
    ("names.py", "build_site.py", WORDS, "GIVEN_NAMES"),
    ("names.py", "build_site.py", WORDS, "NAME_PARTICLES"),
    ("names.py", "build_site.py", WORDS, "TITLE_WORDS"),
    ("names.py", "build_site.py", TREE, "_has_corporate_word"),
    ("names.py", "build_site.py", TREE, "_without_titles"),
    ("names.py", "build_site.py", TREE, "_name_tokens"),
    ("names.py", "build_site.py", TREE, "_norm_name"),
    ("names.py", "build_site.py", TREE, "load_vendor_allowlist"),
    ("names.py", "build_site.py", TREE, "is_individual"),
    ("names.py", "build_site.py", TREE, "is_person_shaped"),
    ("names.py", "build_site.py", TREE, "suppress_individuals"),
    # Starts empty on both sides and is filled at run time. Watched anyway: if
    # the site ever seeds it with a default, an unseeded copy would suppress
    # names the site publishes, and nothing else here would notice.
    ("names.py", "build_site.py", TREE, "VENDOR_ALLOWLIST"),

    ("categories.py", "build_site.py", WORDS, "PLACEHOLDER_CATEGORY_NAMES"),
    ("categories.py", "build_site.py", TREE, "is_placeholder_category"),
    ("categories.py", "build_site.py", TREE, "category_norm"),
    ("categories.py", "build_site.py", TREE, "load_category_merges"),
    ("categories.py", "build_site.py", TREE, "category_key_of"),
    ("categories.py", "build_site.py", TREE, "add_category_key"),
    ("categories.py", "build_site.py", TREE, "CATEGORY_MERGES"),

    # M2-DESIGN 4.2: "The same for ingest.py's normalising and de-duplicating
    # functions." Contract is included because normalize() returns one and a
    # field added or renamed there changes what the scanner reads.
    ("ingest.py", "ingest.py", TREE, "Contract"),
    ("ingest.py", "ingest.py", WORDS, "VENDOR_STOPWORDS"),
    ("ingest.py", "ingest.py", WORDS, "RECOMPETE_COMMODITY_TYPES"),
    ("ingest.py", "ingest.py", TREE, "parse_date"),
    ("ingest.py", "ingest.py", TREE, "parse_money"),
    ("ingest.py", "ingest.py", TREE, "parse_int"),
    ("ingest.py", "ingest.py", TREE, "expiry_bucket"),
    ("ingest.py", "ingest.py", TREE, "competition_density"),
    ("ingest.py", "ingest.py", TREE, "vendor_key"),
    ("ingest.py", "ingest.py", TREE, "derive_category_names"),
    ("ingest.py", "ingest.py", TREE, "detect_sole_sourced"),
    ("ingest.py", "ingest.py", TREE, "build_contract_key"),
    ("ingest.py", "ingest.py", TREE, "normalize"),
    ("ingest.py", "ingest.py", TREE, "deduplicate"),
    ("ingest.py", "ingest.py", TREE, "filter_recompete"),

    # Beyond what 4.2 asks for. The scanner does its OWN download, so what it
    # downloads is a rule too: a changed resource id would have it diffing a
    # different dataset against yesterday's snapshot and calling the whole thing
    # 25,000 changes.
    ("ingest.py", "ingest.py", VALUE, "CKAN_BASE"),
    ("ingest.py", "ingest.py", VALUE, "RESOURCE_ID"),
    ("ingest.py", "ingest.py", VALUE, "PAGE_SIZE"),
    ("ingest.py", "ingest.py", TREE, "fetch_page"),
    ("ingest.py", "ingest.py", TREE, "iter_all_rows"),
)

# The scanner's own addition to the ingest copy. It is not on the site, so it
# must never be looked for there; naming it here is what stops a future reader
# adding it to WATCHED and getting a refusal that can never be cleared.
SCANNER_ADDITIONS = frozenset({"collect_refs"})

# Copied but deliberately not watched, with the reason. tests/test_drift.py
# asserts every unwatched top-level name in vendor/ appears here, so copying a
# rule and forgetting to watch it fails the suite rather than going unnoticed.
UNWATCHED_BY_DESIGN: dict[str, str] = {
    # The site's own identity string. The scanner overrides it at run time
    # rather than forking the copy, so a change on the site is not a rule the
    # scanner follows.
    "USER_AGENT": "overridden by scan.py; the site's identity, not the scanner's",
    # Output plumbing the scanner never calls. M2-DESIGN 7 forbids writing the
    # pipeline file at all, and the scanner writes to Postgres, not SQLite.
    "INDEXES": "SQLite output; the scanner never calls it",
    "sqlite_schema": "SQLite output; the scanner never calls it",
    "write_sqlite": "SQLite output; the scanner never calls it",
    "self_test": "the site's own fixture self-test; needs a fixture not copied",
    "main": "the site's command line; writes the pipeline file the scanner must not",
}

# (vendor file, site file). Compared line by line after the site's own comment
# stripping, because that is what its loader sees.
WATCHED_DATA: tuple[tuple[str, str], ...] = (
    ("vendor_allowlist.txt", "vendor_allowlist.txt"),
    ("category_merges.txt", "category_merges.txt"),
)


@dataclass(frozen=True)
class Difference:
    """One thing that no longer matches. Carries counts, never words."""

    where: str          # the vendor file
    symbol: str         # the definition or data file
    detail: str         # counts and shapes only


# --------------------------------------------------------------------------
# Reading definitions out of a parsed file
# --------------------------------------------------------------------------


def _top_level(source: str) -> dict[str, ast.AST]:
    """Every top-level definition or simple assignment, by name."""
    return _definitions(ast.parse(source))


def _definitions(tree: ast.Module) -> dict[str, ast.AST]:
    """The same, from a tree already parsed."""
    out: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.name] = node
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(
            node.targets[0], ast.Name
        ):
            out[node.targets[0].id] = node
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out[node.target.id] = node
    return out


_MUTATORS = frozenset({
    "add", "update", "discard", "remove", "pop", "popitem", "clear", "append",
    "extend", "insert", "setdefault", "intersection_update",
    "difference_update", "symmetric_difference_update",
})

# The only extra bindings of a watched name that are allowed, anywhere: the
# site's command-line entry point fills the two run-time tables from their data
# files, exactly as snapshot.load_site_rules does here, and the data files
# themselves are compared line by line in WATCHED_DATA. Each table maps to the
# one loader that may fill it.
#
# The statement must be exactly `TABLE = its_loader(...)`. The first version
# exempted any assignment in main and never looked at the value, so
# `VENDOR_ALLOWLIST -= {...}` in main passed while `.discard()` with the same
# effect refused. An allowlist entry dropped that way is a name the site
# withholds and the scanner publishes. Found by round three of the review, run
# on 18 September 2026.
_RUNTIME_LOADERS = {
    "VENDOR_ALLOWLIST": "load_vendor_allowlist",
    "CATEGORY_MERGES": "load_category_merges",
}
LOADED = "filled by its loader"


def _other_bindings(source: str, symbols: Iterable[str]) -> list[tuple[str, str, str]]:
    """Every statement, other than a symbol's one definition, that binds or
    changes a watched symbol. (symbol, how, enclosing function or <module>).

    WHY. Python uses the LAST binding of a name, and _top_level reads only four
    statement shapes. The review of 17 September found seven others that
    changed the effective rule while check_drift compared an untouched first
    definition and returned nothing:

        GIVEN_NAMES |= frozenset("quillan".split())      # the natural way to
        CORP_WORDS -= {"SERVICES"}                        # extend a frozenset,
        GIVEN_NAMES = _V2 = ...                           # which is what site
        GIVEN_NAMES, _ = ...                              # PR #19 did
        from somewhere import is_individual
        PLACEHOLDER_CATEGORY_NAMES.add("general")

    and the same on the vendor side, where one appended `CORP_WORDS |= {...}`
    published a name the site withholds while every test stayed green. So
    rather than teach _top_level every shape there is, anything that touches a
    watched name outside its definition is found here, on both sides, and
    refuses the run. Fail closed.

    NOT caught, and said so rather than implied: deliberately disguised
    rebinding — globals()["NAME"] = ..., setattr on the module, exec(), or a
    star-import from a module that defines the name. Round three of the review,
    run on 18 September 2026, confirmed none of them is caught, and searched
    both real site files for globals(), setattr, exec, eval, star-imports,
    sys.modules, vars() and __dict__: none appears. The site imports only the
    standard library. So none is judged a realistic way to edit a word list; a
    change in one of those forms would be a restructuring of the site that a
    person re-copying vendor/ could not miss. (The version of this paragraph
    pushed on 17 September credited that round before it had run.)
    """
    wanted = set(symbols)
    tree = ast.parse(source)
    # The definitions are found in THIS tree. Taking them from a second parse
    # of the same text matched nothing, because node identity is per parse,
    # and every definition then counted as a rebinding of itself. Measured on
    # the real files on 17 September, not assumed.
    defs = _definitions(tree)
    definition_nodes: set[int] = set()
    for name in wanted:
        node = defs.get(name)
        if node is None:
            continue
        definition_nodes.add(id(node))
        targets = list(getattr(node, "targets", []))
        if isinstance(node, ast.AnnAssign):
            targets.append(node.target)
        definition_nodes.update(id(t) for t in targets)

    # The target of each `TABLE = its_loader(...)`. Only a single plain target
    # counts: `TABLE = _SPARE = loader()` binds a second name to the same
    # object, which can then be changed without the table's name appearing.
    loader_targets: set[int] = set()
    for stmt in ast.walk(tree):
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and stmt.targets[0].id in _RUNTIME_LOADERS
            and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Name)
            and stmt.value.func.id == _RUNTIME_LOADERS[stmt.targets[0].id]
        ):
            loader_targets.add(id(stmt.targets[0]))

    found: list[tuple[str, str, str]] = []

    def declared_global(scope: ast.AST) -> set[str]:
        names: set[str] = set()
        for stmt in ast.walk(scope):
            if stmt is not scope and isinstance(
                stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
            ):
                continue
            if isinstance(stmt, ast.Global):
                names.update(stmt.names)
        return names

    def visit(node: ast.AST, where: str, rebinds: Optional[set[str]]) -> None:
        # `rebinds` is None at module level, where every binding is the
        # module's. Inside a function or class a plain assignment binds a LOCAL
        # name — ingest.Contract has a field called vendor_key, which is not the
        # function vendor_key — so it counts only if that scope declared the
        # name global. Changing the object itself (.add(), item assignment)
        # reaches the module's object from anywhere, so that always counts.
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if (
                    child.name in wanted
                    and id(child) not in definition_nodes
                    and (rebinds is None or child.name in rebinds)
                ):
                    found.append((child.name, "defined again", where))
                visit(child, child.name, declared_global(child))
                continue
            if isinstance(child, ast.Name) and child.id in wanted:
                if (
                    isinstance(child.ctx, (ast.Store, ast.Del))
                    and id(child) not in definition_nodes
                    and (rebinds is None or child.id in rebinds)
                ):
                    if isinstance(child.ctx, ast.Del):
                        how = "deleted"
                    elif id(child) in loader_targets:
                        how = LOADED
                    else:
                        how = "assigned"
                    found.append((child.id, how, where))
            elif isinstance(child, (ast.Global, ast.Nonlocal)):
                found.extend((n, "declared global", where) for n in child.names if n in wanted)
            elif isinstance(child, ast.alias):
                bound = (child.asname or child.name).split(".")[0]
                if bound in wanted and (rebinds is None or bound in rebinds):
                    found.append((bound, "imported", where))
            elif (
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Attribute)
                and isinstance(child.func.value, ast.Name)
                and child.func.value.id in wanted
                and child.func.attr in _MUTATORS
            ):
                found.append((child.func.value.id, f"changed by .{child.func.attr}()", where))
            elif (
                isinstance(child, (ast.Subscript, ast.Attribute))
                and isinstance(getattr(child, "ctx", None), (ast.Store, ast.Del))
                and isinstance(child.value, ast.Name)
                and child.value.id in wanted
            ):
                found.append((child.value.id, "changed by item assignment", where))
            visit(child, where, rebinds)

    visit(tree, "<module>", None)
    return found


def _unreadable_bindings(source: str, symbols: Iterable[str]) -> dict[str, int]:
    """_other_bindings, minus the site's own run-time loaders, counted per symbol."""
    out: dict[str, int] = {}
    for name, how, where in _other_bindings(source, symbols):
        if (
            name in _RUNTIME_LOADERS
            and where == "main"
            and how in ("declared global", LOADED)
        ):
            continue
        out[name] = out.get(name, 0) + 1
    return out


def _strip_docstrings(node: ast.AST) -> ast.AST:
    """A copy of the tree with every docstring removed.

    A docstring is documentation. The site's are long, are edited often, and
    cannot change which names are suppressed. Leaving them in would make the
    weekly run refuse on a corrected sentence, and a check that refuses for a
    reason nobody believes is a check somebody switches off.
    """
    clone = ast.parse(ast.unparse(node)).body[0]
    for sub in ast.walk(clone):
        if not isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
            continue
        body = getattr(sub, "body", None)
        if not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            # `pass` keeps a body that was only a docstring syntactically valid.
            sub.body = body[1:] or [ast.Pass()]
    return clone


def _word_set(node: ast.AST) -> Optional[frozenset[str]]:
    """The words a word-list assignment defines, or None if it is not one.

    Handles the two shapes the site uses and nothing else, on purpose. A third
    shape appearing should be a loud "cannot read this" rather than a quiet
    guess at what it means.

        NAME = frozenset(\"\"\"a b c\"\"\".split())
        NAME = {"a", "b", "c"}
    """
    value = getattr(node, "value", None)
    if value is None:
        return None
    if isinstance(value, (ast.Set, ast.Tuple, ast.List)):
        try:
            return frozenset(str(x) for x in ast.literal_eval(value))
        except (ValueError, TypeError):
            return None
    if (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id in {"frozenset", "set"}
        and len(value.args) == 1
    ):
        inner = value.args[0]
        if (
            isinstance(inner, ast.Call)
            and isinstance(inner.func, ast.Attribute)
            and inner.func.attr == "split"
            and isinstance(inner.func.value, ast.Constant)
            and isinstance(inner.func.value.value, str)
        ):
            if inner.args or inner.keywords:
                # .split(sep) or .split(maxsplit=...) builds a different set
                # from the same string, and a bare .split() here would compute
                # the same words for both sides and pass. Review, 17 September.
                return None
            return frozenset(inner.func.value.value.split())
        try:
            return frozenset(str(x) for x in ast.literal_eval(inner))
        except (ValueError, TypeError):
            return None
    return None


def _constant(node: ast.AST) -> tuple[bool, Any]:
    value = getattr(node, "value", None)
    if isinstance(value, ast.Constant):
        return True, value.value
    return False, None


def data_lines(text: str) -> list[str]:
    """A data file as its loader sees it: comments and blank lines gone.

    load_vendor_allowlist and load_category_merges both do `split("#", 1)[0]`
    then `strip()` then skip empties, so a comment rewritten on either side is
    not a rule change and must not refuse the run.
    """
    out = []
    for raw in text.split("\n"):
        line = raw.split("#", 1)[0].strip()
        if line:
            out.append(line)
    return out


# --------------------------------------------------------------------------
# The comparison — pure, no network, no file system
# --------------------------------------------------------------------------


def check_drift(
    site_sources: dict[str, str],
    vendor_sources: dict[str, str],
    watched: Iterable[tuple[str, str, str, str]] = WATCHED,
    watched_data: Iterable[tuple[str, str]] = WATCHED_DATA,
) -> list[Difference]:
    """Every way vendor_sources no longer matches site_sources.

    Both dicts are filename -> text. An empty result means the copies are
    current; anything else refuses the run.
    """
    differences: list[Difference] = []
    parsed: dict[str, dict[str, ast.AST]] = {}

    def defs(bucket: dict[str, str], filename: str) -> Optional[dict[str, ast.AST]]:
        cache_key = f"{id(bucket)}:{filename}"
        if cache_key not in parsed:
            text = bucket.get(filename)
            parsed[cache_key] = None if text is None else _top_level(text)
        return parsed[cache_key]

    watched = list(watched)
    symbols_in: dict[str, set[str]] = {}
    for vendor_file, site_file, _, symbol in watched:
        symbols_in.setdefault(f"v:{vendor_file}", set()).add(symbol)
        symbols_in.setdefault(f"s:{site_file}", set()).add(symbol)
    unreadable_cache: dict[str, dict[str, int]] = {}

    def unreadable(bucket: dict[str, str], filename: str, side: str) -> dict[str, int]:
        cache_key = f"{side}:{filename}"
        if cache_key not in unreadable_cache:
            text = bucket.get(filename)
            unreadable_cache[cache_key] = (
                {} if text is None
                else _unreadable_bindings(text, symbols_in.get(cache_key, set()))
            )
        return unreadable_cache[cache_key]

    for vendor_file, site_file, kind, symbol in watched:
        ours = defs(vendor_sources, vendor_file)
        theirs = defs(site_sources, site_file)
        if ours is None:
            differences.append(Difference(vendor_file, symbol, "the copy is missing"))
            continue
        if theirs is None:
            differences.append(Difference(vendor_file, symbol, f"{site_file} was not read"))
            continue

        a, b = ours.get(symbol), theirs.get(symbol)
        if a is None and b is None:
            differences.append(
                Difference(vendor_file, symbol, "not defined here or on the site")
            )
            continue
        if a is None:
            differences.append(Difference(vendor_file, symbol, "not copied"))
            continue
        if b is None:
            differences.append(
                Difference(vendor_file, symbol, f"gone from the site's {site_file}")
            )
            continue

        # Before comparing the definition, make sure it IS the rule. A later
        # statement that rebinds or changes the name means Python runs
        # something other than what is about to be compared. See
        # _other_bindings for the seven shapes that got through.
        here = unreadable(vendor_sources, vendor_file, "v").get(symbol, 0)
        there = unreadable(site_sources, site_file, "s").get(symbol, 0)
        if here or there:
            differences.append(
                Difference(
                    vendor_file,
                    symbol,
                    f"changed somewhere drift.py cannot compare: "
                    f"{here} statement(s) here, {there} on the site",
                )
            )
            continue

        if kind == TREE:
            if ast.dump(_strip_docstrings(a)) != ast.dump(_strip_docstrings(b)):
                differences.append(
                    Difference(vendor_file, symbol, "the code differs, docstrings aside")
                )
        elif kind == WORDS:
            aw, bw = _word_set(a), _word_set(b)
            if aw is None or bw is None:
                differences.append(
                    Difference(vendor_file, symbol, "cannot be read as a word list")
                )
            elif aw != bw:
                differences.append(
                    Difference(
                        vendor_file,
                        symbol,
                        f"{len(aw - bw)} word(s) here are not on the site, "
                        f"{len(bw - aw)} on the site are not here",
                    )
                )
        elif kind == VALUE:
            ok_a, va = _constant(a)
            ok_b, vb = _constant(b)
            if not ok_a or not ok_b:
                differences.append(
                    Difference(vendor_file, symbol, "is not a plain constant on both sides")
                )
            elif va != vb:
                differences.append(Difference(vendor_file, symbol, "the value differs"))
        else:  # pragma: no cover - a typo in WATCHED, not a runtime state
            raise ValueError(f"unknown comparison kind {kind!r}")

    for vendor_file, site_file in watched_data:
        ours_text = vendor_sources.get(vendor_file)
        theirs_text = site_sources.get(site_file)
        if ours_text is None:
            differences.append(Difference(vendor_file, vendor_file, "the copy is missing"))
            continue
        if theirs_text is None:
            differences.append(Difference(vendor_file, vendor_file, "the site's was not read"))
            continue
        a, b = data_lines(ours_text), data_lines(theirs_text)
        if a != b:
            extra = len([x for x in a if x not in b])
            missing = len([x for x in b if x not in a])
            differences.append(
                Difference(
                    vendor_file,
                    vendor_file,
                    f"{len(a)} entries here against {len(b)} on the site; "
                    f"{extra} here are not there, {missing} there are not here",
                )
            )

    return differences


def unwatched_definitions(vendor_source: str, vendor_file: str) -> list[str]:
    """Top-level names in a vendor copy that WATCHED does not mention.

    A rule copied and then not watched is a copy that can go stale in silence,
    which is the whole thing this module exists to stop. Private helpers that
    the watched code calls are not exempt: _has_corporate_word is where the
    NAME_PARTICLES rule actually lives.
    """
    watched_here = {s for v, _, _, s in WATCHED if v == vendor_file}
    out = []
    for name in _top_level(vendor_source):
        if name in watched_here or name in SCANNER_ADDITIONS:
            continue
        out.append(name)
    return out


# --------------------------------------------------------------------------
# The network half
# --------------------------------------------------------------------------


def _get(url: str, timeout: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def site_head_sha(timeout: int = 30) -> str:
    """The commit main points at right now.

    Read FIRST, and every file then fetched at that exact commit rather than at
    `main`. Fetching four files from a moving branch can straddle a push and
    compare two halves of two different versions, which would refuse the run for
    a difference that exists in neither.
    """
    body = _get(f"https://api.github.com/repos/{SITE_REPO}/commits/{SITE_BRANCH}", timeout)
    return json.loads(body.decode("utf-8"))["sha"]


def fetch_site_file(sha: str, path: str, timeout: int = 60) -> str:
    return _get(
        f"https://raw.githubusercontent.com/{SITE_REPO}/{sha}/{path}", timeout
    ).decode("utf-8")


def read_vendor_sources(vendor_dir: str = VENDOR) -> dict[str, str]:
    names = sorted({v for v, _, _, _ in WATCHED} | {v for v, _ in WATCHED_DATA})
    out = {}
    for name in names:
        path = os.path.join(vendor_dir, name)
        with open(path, encoding="utf-8") as fh:
            out[name] = fh.read()
    return out


def main(argv: Optional[list[str]] = None) -> int:
    """0 when the copies are current, 1 when they are not, 2 when unreadable.

    2 is separate from 1 on purpose. A difference is a pull request somebody
    writes; a network failure is a retry. Both refuse the run, and scan.py
    records `drift` either way, but a person reading the log needs to know
    which happened.
    """
    del argv
    try:
        sha = site_head_sha()
        site_files = sorted({s for _, s, _, _ in WATCHED} | {s for _, s in WATCHED_DATA})
        site_sources = {name: fetch_site_file(sha, name) for name in site_files}
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        print(f"drift: could not read the site. {type(exc).__name__}", file=sys.stderr)
        return 2

    try:
        vendor_sources = read_vendor_sources()
    except OSError as exc:
        print(f"drift: could not read scanner/vendor. {type(exc).__name__}", file=sys.stderr)
        return 2

    differences = check_drift(site_sources, vendor_sources)
    if not differences:
        print(f"drift: vendor/ matches {SITE_REPO} at {sha[:7]}. "
              f"{len(WATCHED)} definitions, {len(WATCHED_DATA)} data files.")
        return 0

    print(
        f"drift: REFUSING. scanner/vendor no longer matches {SITE_REPO} at {sha[:7]}.",
        file=sys.stderr,
    )
    for d in differences:
        print(f"  {d.where}: {d.symbol} — {d.detail}", file=sys.stderr)
    print(
        "\nRe-copy the changed definitions from the site in a pull request. "
        "Do not edit them to make this pass: that publishes names the site "
        "withholds. M2-DESIGN 4.2.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
