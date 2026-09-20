# Walltap v2 Roadmap (updated to match the actual codebase)

> Status: **Phase 1 largely done** (the app already runs on Supabase — commit `a4710fa`).
> This document is the working plan for the gaps that remain.

Architecture target:

```
┌─────────────────┐        ┌──────────────────┐
│   Chat app       │◄──────►│                   │
│ (Render/Railway) │        │    Supabase       │
└─────────────────┘        │ (DB, Auth,        │
                            │  Storage,         │
┌─────────────────┐        │  Realtime)        │
│  Admin dashboard │◄──────►│                   │
│    (Netlify)     │        └──────────────────┘
└─────────────────┘
        ▲
        │ privileged reads via Netlify Functions + service role key
```

TURN/calling service (Cloudflare Calls / Twilio) — used directly by the chat
app's browser clients for call media.

---

## Phase 1 — Supabase backend (foundation) — NEARLY DONE

### Done
- [x] `@supabase/supabase-js`; no `better-sqlite3` / `express-session`
- [x] Email/password auth via Supabase Auth (JWT, server-verified in `requireAuth`)
- [x] Storage uploads (multer in-memory → Supabase Storage)
- [x] Schema bootstrap on boot via `pg` (`SCHEMA_SQL` in `server.js`)
- [x] **profiles** table + trigger auto-creating a row on `auth.users` insert,
      with `is_admin` flag (defaults `false`)
- [x] **events** table for analytics (message_sent / file_uploaded /
      message_deleted logged server-side; page_view logged client-side)
- [x] **admin_profiles** view (joins `auth.users.email`) for service-role reads
- [x] RLS **enabled + policies** on `posts`, `post_files`, `profiles`, `events`
- [x] Storage bucket **private**; files served via **signed URLs**
      (`createSignedUrl`, TTL default 7 days)

### Done (this pass)
- [x] Server-side analytics in `events`: `message_sent`, `file_uploaded`,
      `message_deleted` (server) and `page_view` (client).
- [x] Storage bucket forced to **private** on every boot; files served via
      `createSignedUrl` (`SIGNED_URL_TTL_SECONDS`, default 7 days).
- [x] `scripts/provision-admin.js` — creates a dedicated admin account in one
      command: `npm run provision-admin`. Refuses to promote an existing
      regular account (Phase 2 §2.2: admin ≠ regular user).
- [x] **Realtime (was §1.6):** SSE removed. Server + browser now share a
      Supabase Realtime **broadcast** channel (`board`), gated by RLS policies
      on `realtime.messages`. Phase 3 calls can reuse this transport.
- [x] **Soft delete:** posts now set `deleted_at`/`hidden_from_user` instead of
      hard-deleting. Feeds (and the `posts readable` RLS policy) hide them;
      `list-all-messages` still returns them, with a "deleted" badge, for the
      moderation view.
- [x] **Privacy disclosure:** the chat app footer carries the retention clause
      ("erased messages may be retained for moderation and safety purposes").

### Remaining / decisions
- [ ] Backfill `profiles` for auth users created *before* the trigger
      (one-time SQL or `netlify`-side `on conflict do nothing`; new signups and
      admin provisioning are already handled by the trigger + script).
- [ ] Table hardening: consider `CHECK` on `text` length (currently enforced in
      route only) and a `CHECK` on `posts.timestamp` for sanity.

---

## Phase 2 — Admin panel + analytics (separate repo) — SCAFFOLDED

Located at **`whatapp-admin/`** (git-ignored here; should be its own repo,
deployed on Netlify).

### In the scaffold
- `netlify.toml` — publish root + `netlify/functions`
- `config.js` — SUPABASE_URL + anon key for the browser
- `index.html` / `admin.js` — login + Overview (stats & bar charts), Users,
  Messages tabs. Vanilla JS (matches chat app; no build step).
- `netlify/functions/_shared/supabase.js` — `requireAdmin()` verifies the
  caller's JWT server-side **and** checks `profiles.is_admin = true`; admin
  client (`adminClient()`) uses the service role key (env only).
- `netlify/functions/list-users.js` — full user list incl. emails
  (via `admin_profiles` view)
- `netlify/functions/list-all-messages.js` — every post + file metadata
- `netlify/functions/analytics-summary.js` — totals, active users, events &
  posts-per-day over 30 days

### To finish
- [ ] `git init` + separate deploy pipeline + domain (`admin.*`)
- [ ] Set Netlify env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (frontend),
      `SUPABASE_SERVICE_ROLE_KEY` (functions only, never in frontend)
- [x] Grant your account `is_admin = true` in `profiles`
      (done via `npm run provision-admin` in the chat app repo — uses a
      *separate* admin email, never a regular user's account)
- [ ] (Optional) charting library / more analysis; admin UI polish
- [x] Add retention clause to privacy policy / ToS: "deleted content may be
      retained for moderation and safety purposes." (shown in the chat app footer)

---

## Phase 3 — Voice & video calls — NOT STARTED

- WebRTC peer-to-peer media between two browsers.
- Signaling via Supabase Realtime broadcast channel per call (`call:{id}`) —
  carrying offer/answer/ICE. No separate signaling server.
- TURN needed as a fallback for real-world NATs. Recommend starting managed
  (Cloudflare Calls / Twilio), revisit self-hosting coturn at scale.
- Call state machine: `idle → calling/ringing → connecting → active → ended`.
- UI: incoming call notification (accept/decline), ringing screen w/ cancel,
  in-call controls (mute, camera toggle, hang up, switch camera), optional
  call history logged to Supabase.

Rough effort: 2–3 weeks.

---

## Phase 4 — Hosting & operations — PARTIAL

### Done
- [x] Chat app deploy config (`render.yaml`, Render free tier) + env checklist

### Remaining
- [ ] Admin deploy on Netlify (see Phase 2)
- [ ] Schema changes through migrations so both repos stay in sync
  (`supabase db push` or SQL editor)
- [ ] Monitoring: Supabase dashboard basics + Sentry (free tier) in both repos
      once real users exist

---

## Env var checklist

| Service | Variables |
| --- | --- |
| Chat app (Render) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `MAX_FILE_SIZE_MB`, `MAX_FILES`, `STORAGE_BUCKET`, `SIGNED_URL_TTL_SECONDS` |
| Admin (Netlify) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (frontend), `SUPABASE_SERVICE_ROLE_KEY` (functions only) |

## Security checklist

- [ ] RLS enabled + policies on **every** table; test with a non-admin account
- [x] `SUPABASE_SERVICE_ROLE_KEY` only as a server-side env var, never in
      frontend code or committed
- [x] Admin routes verify `is_admin` server-side (Netlify functions), not just
      hidden in the UI — the scaffold's `requireAdmin()` does this
- [x] Storage bucket private; signed URLs for file access
- [ ] Privacy/ToS disclosure for content retention
- [x] `.env` git-ignored in both repos