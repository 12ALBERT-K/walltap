# Walltap

A real-time public board — messages, file attachments, voice notes and live
1:1 video calls — built with **Node.js + Express** on **Supabase** (Auth,
Postgres, Storage, Realtime).

## Stack

- **Backend** — Express (`server.js`). Boots an idempotent schema
  (`SCHEMA_SQL`), verifies JWTs server-side, uploads files to private storage,
  serves signed URLs, and broadcasts new/deleted posts over Supabase Realtime.
- **Frontend** — plain ES2020 in `public/` (no build step): `index.html`,
  `app.js`. Supabase handles auth, realtime feeds, presence and call signaling.
- **Accounts** — **username + password**, no email address. Supabase Auth only
  speaks email, so `normaliseLogin()` in `public/app.js` maps a username onto a
  synthetic address (`<username>@walltap.local`, a domain with no MX record).
  Real emails typed by earlier users still pass through untouched, so legacy
  accounts keep working. See [Auth model](#auth-model).
- **Calls** — 1:1 WebRTC voice/video. Signaling rides a private Supabase
  Realtime channel (`calls`); presence drives the online bar; ICE is STUN-only
  today (see Phase 3 in `ROADMAP.md` for TURN).
- **Admin dashboard** — separate repo in `walltap-admin/` (Netlify Functions +
  service-role key), with its own README.

## Auth model

Sign-up asks for a **username and a password only**. There is no email field
and no confirmation mail.

Supabase Auth is email-only, so the username is mapped onto a synthetic
address: `alice` → `alice@walltap.local`. Nothing is delivered there — the
domain has no MX record, and none is needed, because the address exists only
to satisfy Supabase's unique-identity constraint.

Consequences worth knowing:

- **No self-service password reset.** `walltap.local` cannot receive mail, so
  "Forgot password?" tells the user to ask an admin, who generates a
  single-use link from the admin dashboard
  (`walltap-admin/netlify/functions/send-reset.js`). Passwords are bcrypt
  hashes, so an admin cannot recover or read a forgotten one — minting a fresh
  link is the only option, and it is the safe one.
- **Turn off "Confirm email"** in Supabase → Auth → Email, otherwise sign-up
  dead-ends waiting for a confirmation that will never arrive.
- **Usernames are the identity.** `handle_new_user()` appends a numeric suffix
  on collision (`alice` → `alice1`), so a taken name degrades to a different
  name instead of a failed registration. The client cannot see the assigned
  name until after sign-in, so tell people to pick something distinctive.
- **Case-insensitive.** Usernames are lowercased before use; `Alice` and
  `alice` are the same account.
- Allowed characters: letters, numbers, `.`, `-`, `_`, 3–40 characters.
- Accounts created before this change keep their real email and the ordinary
  emailed reset link.

## Local development

```bash
cp .env.example .env    # fill in your Supabase project values
npm ci
npm run dev             # nodemon on http://localhost:3000
```

Schema is applied to your Supabase project automatically on boot
(`DATABASE_URL` required). It is safe to re-run — everything is idempotent.

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the server (`server.js`) |
| `npm run dev` | Run with nodemon |
| `npm run provision-admin` | Create the dedicated admin account |
| `npm run backfill-profiles` | Backfill `profiles` rows for pre-trigger users |

## Deploy (Render)

`render.yaml` deploys to Render free tier; set these env vars there:

| Variable | Notes |
| --- | --- |
| `NODE_VERSION` | `20` (set in render.yaml) |
| `SUPABASE_URL` | Project Settings → API |
| `SUPABASE_ANON_KEY` | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side only |
| `DATABASE_URL` | Pooled connection string |
| `MAX_FILE_SIZE_MB` | default 15 |
| `MAX_FILES` | default 5 |
| `STORAGE_BUCKET` | default `uploads` |
| `SIGNED_URL_TTL_SECONDS` | default 604800 |

After first boot, confirm the log shows `Schema → ensured` and
`bucket "uploads" ready (private)`, then create your admin account with
`npm run provision-admin`.

> **Free-tier warning:** the Supabase free plan pauses a project after ~7 days of
> inactivity, and Render's free tier (where still available for new accounts)
> spins down after ~15 minutes idle. A site that demos fine can be dead a week
> later. Add billing, or set a reminder to touch the project.

## Security model

The server uses the **service role** key, so it bypasses RLS. RLS is defence in
depth for direct access to Supabase, and the anon key is public by necessity (it
is served to every browser at `/config.js`):

- `posts` may only be inserted by an authenticated user matching `author_id`.
- `profiles` grants `UPDATE (username)` only, so a signed-in user cannot promote
  themselves with `is_admin = true`.
- `admin_profiles` (the view exposing `auth.users.email`) is revoked from
  `anon`/`authenticated` and granted to `service_role` only. Views run as their
  owner and bypass RLS, so without that revoke the whole user list would be
  readable with the public anon key.
- `events` may only be inserted for your own `user_id`.

If you change any policy in `SCHEMA_SQL`, re-verify these grants — Supabase
grants all privileges on new objects in `public` to `anon` by default.

## Known limitations

Unfixed, and worth knowing before this meets real traffic:

- **`GET /api/posts` has no pagination and signs every attachment on every
  request** (`rowToPost` → `createSignedUrl` per file). At PostgREST's 1000-row
  ceiling that is up to ~1,000 concurrent Storage calls per page load, and this
  endpoint is not rate limited. Expect trouble well before 1,000 posts.
- **The feed renders every post** with no virtualisation, and does one DOM query
  per post while loading.
- **Signed URLs expire after 7 days** and there is no refresh endpoint, so
  attachments in old posts break permanently once the TTL passes.
- **Soft-deleted posts keep their files in Storage forever**; there is no
  cleanup job.
- **Calls are STUN-only** — no TURN — so they fail on symmetric NAT and most
  corporate/mobile networks. There is also no connect-phase timeout, so a failed
  call can sit on "Connecting…" with the camera still on.
- `npm run backfill-profiles` reads all profile ids in one unpaginated query; past
  1,000 profiles an existing admin can fall outside the fetched set and be
  overwritten with `is_admin = false`. Fix before running it on a large project.
- `npm run provision-admin` refuses to touch an account that already exists
  unless you pass `--promote`. Promotion is safe to do for an account the script
  itself half-created, but it is also the exact operation that would turn a real
  user's account into an admin — so it is never automatic.
- Uploads are rejected with HTTP 500 rather than 400 when the file type is not
  allowed, so the client shows a generic error.
- `logEvent` wraps its insert in `try/catch`, but supabase-js returns `{ error }`
  instead of throwing — so analytics failures are silent.

## Schema changes

`SCHEMA_SQL` in `server.js` is the single source of truth — every statement is
idempotent. For production, apply changes via the Supabase SQL editor (or
`supabase db push`). See `migrations/README.md`.

## Admin dashboard

See `walltap-admin/README.md`. It is its own repo, deployed on Netlify, with
the functions gated by server-side admin checks.

More detail in [`ROADMAP.md`](ROADMAP.md).