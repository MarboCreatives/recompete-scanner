# Environment variables

No secret is ever committed to this repository. Every value below lives in
Vercel's project settings, and is pulled to a local `.env.local` (git-ignored)
with `vercel env pull` when working on the app.

There is deliberately no committed `.env.example`. Vercel's own tooling appends
`.env*` to the root `.gitignore` every time it runs, which would hide such a
file; this document is the list instead.

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

| Variable | Who sets it | Use |
|---|---|---|
| `RESEND_API_KEY` | Jon, in the Vercel dashboard | Sends the magic-link email. Created at resend.com and pasted straight into Vercel; it is never seen by Claude and never written to a file in this repository. |

## Set by Vercel itself

| Variable | Use |
|---|---|
| `VERCEL_OIDC_TOKEN` | Written into `.env.local` by `vercel env pull`. Short-lived, for local development only. |

## Still to be added

The remaining variables for Iteration 0 are added when the sign-in code lands,
and this table is updated in the same pull request.
