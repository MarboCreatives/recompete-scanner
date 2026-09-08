# Environment variables

No secret is ever committed to this repository. Every value below lives in
Vercel's project settings, and is pulled to a local `.env.local` (git-ignored)
with `vercel env pull` when working on the app.

There is deliberately no committed `.env.example`. Vercel's own tooling appends
`.env*` to the root `.gitignore` every time it runs, which would hide such a
file; this document is the list instead.

## Two things to know before adding a variable here

**Add public values with `--type config`.** `vercel env add` stores a value as
type Secret unless told otherwise. A Secret is hidden in the dashboard and is
not returned by `vercel env pull`, so nobody can read it back, including a
future attempt to work out why something is broken. That is right for an API
key and wrong for a URL.

**Do not pipe the value in from PowerShell.** Measured 5 September 2026:
`'https://...' | vercel env add APP_URL production` stores the value with a
UTF-8 byte-order mark in front of it, and setting `$OutputEncoding` does not fix
it. `new URL()` does not strip that character, so it throws, and the site
answers a bare 403 to every form submission while the dashboard shows the
variable set correctly. Write the value to a file and redirect it in through
`cmd` instead. The full account is `GROUND-TRUTH.md` G21.

## Set automatically by the Neon integration

Connected 2 September 2026 through the Vercel dashboard, resource name
`recompete`, region US East (N. Virginia), all three environments. Nothing here
is set by hand; disconnecting and reconnecting the resource rewrites them.

| Variable | Use |
|---|---|
| `DATABASE_URL` | Pooled connection. Used by the app at request time. |
| `DATABASE_URL_UNPOOLED` | Direct connection. Used for schema migrations, which must not run through a pooler. |
| `NEON_PROJECT_ID` | Identifies the Neon project. |
| `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Individual parts of the same connection. Not used by the app; the integration sets them. |
| `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL`, `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | Legacy aliases kept for compatibility with older templates. Not used by the app. |
| `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL` | Neon Auth. **Not used.** This app has its own magic-link sign in and does not use Neon Auth. |

## Set by hand

| Variable | Required | Who sets it | Use, and what happens when it is wrong |
|---|---|---|---|
| `APP_URL` | **Yes, on production** | Set 5 September 2026, type Config | The address this deployment answers on, currently `https://app.recompeteradar.ca` (it was `https://recompete-scanner.vercel.app` until 7 September 2026; see GROUND-TRUTH G35 for what moving it without moving this variable did). Two things read it: the origin check on every form submission, and the link inside the sign-in email. **Unset on production, every form submission returns a bare 403** and nobody can sign in, sign out or delete an account; the fallback is the git-branch URL, which sits behind the Vercel login. Changing it invalidates any sign-in link already emailed. |
| `EMAIL_FROM` | **Yes, once `RESEND_API_KEY` is set** | Jon, in the Vercel dashboard | The From address, in the form `Recompete Scanner <notifications@example.com>`. Read only when the dry run is off and a key is present, so it is harmless while there is no key and **fatal the moment one is added**: `requireEnv` throws, the throw is outside the route's error handling, and `POST /auth/request` answers 500. Until a sending domain is verified, Resend's onboarding sender only delivers to the Resend account owner. |
| `INVITED_EMAILS` | **Yes, while the watchlist is in testing** | Jon, in the Vercel dashboard, type Config | The addresses allowed to sign in, comma separated: the four testers and Jon. `POST /auth/request` refuses anything else **before it touches the database and before either rate cap is counted**, so a stranger holding down the form cannot spend the hourly cap that protects the testers. **Unset, nobody can sign in at all, Jon included.** That is deliberate: the gate fails closed so a redeploy that lost the variable cannot silently reopen the door, and `sign_in_allowlist_missing` in the logs is the only thing that would say so. Mixed case, padding spaces and a trailing comma are all fine; an entry that will not parse is skipped and counted as `sign_in_allowlist_entry_invalid`, and the entry itself is never printed. Type **Config, not Secret** — a Secret cannot be read back, and a list has to be readable to be edited. The addresses are personal data under MASTER-DESIGN rule 8: they live here and in the git-ignored `.env.local`, **never in the repository and never in a log**. This variable and `app/src/lib/invited.ts` are deleted together when the product starts charging. |
| `RESEND_API_KEY` | No, until a real send is wanted | Jon, in the Vercel dashboard | Sends the magic-link email. Created at resend.com and pasted straight into Vercel; it is never seen by Claude and never written to a file in this repository. Absent, sign-in requests are recorded and the send is reported as failed, which is the current state. |
| `EMAIL_DRY_RUN` | No | Nobody, on Vercel | Set to `1` locally to print the sign-in link to the server output instead of sending it. This is how the flow tests run without an email account. **Refused outright on a production deployment**, deliberately: a dry run there would mean people asking for links, never receiving them, and the links sitting in a log. In PowerShell set it to `'0'`, never `''`; an empty string deletes the variable rather than clearing it. |
| `RESEND_BASE_URL` | No | Nobody, on Vercel | Points the sender at a stub instead of Resend, used by `tests/send-path.test.mjs`. **Refused outright on a production deployment**, because left set there it would send every sign-in link to a test endpoint, silently. |

## Set by Vercel itself

| Variable | Use |
|---|---|
| `VERCEL_ENV` | `production`, `preview` or `development`. Gates the deploy migration, the dry-run refusal and the `RESEND_BASE_URL` refusal. |
| `VERCEL_BRANCH_URL` | The git-branch address of a deployment. Used as the fallback when `APP_URL` is unset; see the warning in the `APP_URL` row. |
| `VERCEL_OIDC_TOKEN` | Written into `.env.local` by `vercel env pull`. Short-lived, for local development only. |
