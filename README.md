# Walltap

A real-time public board — messages, file attachments, voice notes and live
1:1 video calls — built with **Node.js + Express** on **Supabase** (Auth,
Postgres, Storage, Realtime).

## Stack

- **Backend** — Express (`server.js`). Boots an idempotent schema
  (`SCHEMA_SQL`), verifies JWTs server-side, uploads files to private storage,
  serves signed URLs, and broadcasts new/deleted posts over Supabase Realtime.
- **Frontend** — plain ES2020 in `public/` (no build step): `index.html`,
  `app.js`. Supabase handles auth (email/password), realtime feeds, presence
  and call signaling.
- **Calls** — 1:1 WebRTC voice/video. Signaling rides a private Supabase
  Realtime channel (`calls`); presence drives the online bar; ICE is STUN-only
  today (see Phase 3 in `ROADMAP.md` for TURN).
- **Admin dashboard** — separate repo in `walltap-admin/` (Netlify Functions +
  service-role key), with its own README.

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

## Schema changes

`SCHEMA_SQL` in `server.js` is the single source of truth — every statement is
idempotent. For production, apply changes via the Supabase SQL editor (or
`supabase db push`). See `migrations/README.md`.

## Admin dashboard

See `walltap-admin/README.md`. It is its own repo, deployed on Netlify, with
the functions gated by server-side admin checks.

More detail in [`ROADMAP.md`](ROADMAP.md).