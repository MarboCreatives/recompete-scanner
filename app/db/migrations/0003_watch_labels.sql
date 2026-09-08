-- Display labels on a watched contract, so a row says what it is.
--
-- ## Why this exists
--
-- A watched contract row read only:
--
--     C-2025-2026-Q4-00435
--     Department nrc-cnrc - added 2026-09-07
--
-- Nobody can tell what they watched from that. The supplier name is the missing
-- piece and the department code is not a name anyone has seen.
--
-- ## Why the name is stored rather than resolved
--
-- 0001_init.sql says, in its header and again above watch_items:
--
--     watch_items store keys, never display names; names are resolved and
--     suppression-checked at the display path
--     ...
--     No display name column, on purpose.
--
-- **That is no longer true for contracts, and this migration is where it stops
-- being true.** It is not edited there because an applied migration is never
-- edited; scripts/migrate.mjs refuses on a checksum change. Read the two files
-- together.
--
-- The rule was written when resolving a name at the display path was possible.
-- For a supplier it still is, and nothing changes: supplier_directory.ts reads
-- the public site's own index and the vendor key IS the name. For a contract
-- there is nothing to resolve from. This application holds no contract data at
-- all until the scanner lands at M2, so there is no display path that could
-- look a supplier name up from a reference number. The choice is a stored label
-- or an unreadable row, and an unreadable row is what Jon has now.
--
-- ## Where the value comes from, and what it is not
--
-- The public site puts it on the Watch link as `&name=` and `&dept=`, and the
-- app stores what arrives. So it is CALLER-CONTROLLED: it comes out of a URL and
-- anyone can type anything into it. Three consequences, all load-bearing:
--
--   * It is never identity. (kind, target_key) remains the only identity and the
--     only unique constraint; nothing joins, groups or looks up by a label. A
--     label is a caption on a row that is already identified.
--   * It is capped here as well as in the application, because a constraint that
--     exists only in TypeScript is not a constraint on the database.
--   * It reaches nobody but the one person whose watchlist it is, so the blast
--     radius of a hostile value is that person's own screen. It is still escaped
--     on output, which React does by default for text children.
--
-- Suppression is NOT re-implemented here and must not be. The site blanks a
-- private individual's vendor_key and sends the literal string "Individual
-- supplier (name withheld)" as the name, upstream of any Watch link being built.
-- That string arriving as a label is correct and is rendered verbatim. Any name
-- logic in this application would be a second implementation of a rule that
-- already exists once, which is MASTER-DESIGN rule 2 and which build_site.py
-- forbids in as many words.
--
-- ## Nullable, and staying nullable
--
-- Every row that already exists has no label, and a Watch link can always arrive
-- without one: an old bookmark, a hand-typed address, or the site before its
-- half of this ships. The watchlist has a fallback sentence for that case. There
-- is no backfill because there is nothing to backfill from.

ALTER TABLE watch_items
  ADD COLUMN label_name text,
  ADD COLUMN label_dept text;

-- 200 is the application's cap in MAX_LABEL_LENGTH, asserted against this
-- constraint by tests/watch-labels.test.mjs so the two cannot drift. The longest
-- vendor_key measured over 25,208 live contracts was 101 characters, so this is
-- a safety limit rather than a working one.
ALTER TABLE watch_items
  ADD CONSTRAINT watch_items_label_name_len
    CHECK (label_name IS NULL OR char_length(label_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT watch_items_label_dept_len
    CHECK (label_dept IS NULL OR char_length(label_dept) BETWEEN 1 AND 200);

-- A label belongs to a contract. A supplier row is identified by its vendor_key,
-- which already IS the display name, so a label there would be a second name for
-- the same thing and could disagree with it. Refused in the database rather than
-- only in the parser, for the same reason the length is.
ALTER TABLE watch_items
  ADD CONSTRAINT watch_items_labels_are_contract_only
    CHECK (kind = 'contract' OR (label_name IS NULL AND label_dept IS NULL));
