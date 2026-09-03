# Database

PostgreSQL on Neon, in US East (N. Virginia). There is no Canadian Neon region;
the privacy policy says plainly that data is stored in the United States.

## Two databases, one Neon project

| Database | Used by | Notes |
|---|---|---|
| `neondb` | Production, Preview and Development | The real one. |
| `recompete_test` | the automated test suite only | Created 2 September 2026. |

They exist because Vercel's Production, Preview and Development environments were
measured on 2 September 2026 and found to hold the **identical** connection
string: same host, same database. Every environment was production. Running the
destructive test suite would have written to live data.

The suite does not get a new secret. It derives its connection from
`DATABASE_URL_UNPOOLED` by replacing only the database name with
`recompete_test`, then asks the server:

```sql
select current_database()
```

and refuses to run anything else unless the answer is exactly `recompete_test`.
Asking the server is the point. Inspecting the connection string before
connecting would trust the very thing being checked, which is how the main site's
name-suppression audit was once fooled.

## Running a migration

`npm run migrate` reads **no** env file. `DATABASE_URL_UNPOOLED` must already be
in the shell, and it must be the direct connection string, not the `-pooler` one.
Nobody migrates a database from a file they did not read; a pulled `.env.local`
holds the Development value, which points at the same database production uses.

From `app`, in PowerShell:

```
$env:DATABASE_URL_UNPOOLED = "<the direct connection string>"
npm run migrate
Remove-Item Env:\DATABASE_URL_UNPOOLED
```

## Rules

1. Additive changes only in Iteration 0.
2. Never edit a migration that has been applied. The runner stores a SHA-256 of
   each file and exits 1 if a recorded file's contents have changed. Add a new
   file instead.
3. A drop or a rename ships one release after the code stops using the column,
   because Vercel's instant rollback moves code without moving schema.
4. `schema_migrations` is created by `scripts/migrate.mjs` and never by a
   migration file. Creating it in both places makes the first deploy fail on
   SQLSTATE 42P07 with nothing migrated.
5. A dropped constraint is not restored by re-running a migration, because the
   file is already recorded as applied. Restore it with a new migration file.
6. To change a migration already applied to `recompete_test` but not yet shipped:
   `DROP DATABASE recompete_test;` then `CREATE DATABASE recompete_test;` and run
   the migration again. Deleting the `schema_migrations` row alone is not enough,
   because the tables the file created still exist, so re-applying it dies on
   SQLSTATE 42P07 at the first `CREATE TABLE`. Once a migration has reached
   production, rule 2 is absolute and the fix is a new file.

## Recovery statements

Clearing a rate-limit lockout, in the Neon SQL editor:

```sql
DELETE FROM sign_in_tokens WHERE email = 'address';
```

Removing a person on request, which is the whole of account deletion:

```sql
DELETE FROM users WHERE id = '<uuid>';            -- cascades sessions, watch_items,
                                                  -- alert_preferences, event_deliveries
DELETE FROM sign_in_tokens WHERE email = '<address>';
```

## What the error handling is built around

Three things were measured against this database on 2 September 2026, and the
migration runner is shaped by them:

- A wrong **host** rejects `connect()` with an error carrying no message, no code
  and no fields at all. The runner therefore prints its own diagnostic rather
  than echoing the error.
- A wrong **password** does **not** reject `connect()`. It resolves, and the
  failure arrives later as an uncaught exception. The runner attaches an `error`
  listener before connecting and forces a `select 1` immediately after, so a bad
  credential becomes a caught, explained failure instead of a crash.
- A constraint violation puts the offending value in the error's `detail`, for
  example `Key (email)=(someone@example.com) already exists`. Only the SQLSTATE
  code is ever printed, because that detail can be personal data.
