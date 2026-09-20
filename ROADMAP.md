# Walltap v2 Roadmap (updated to match the actual codebase)

> Status: **Phase 1 done, Phase 2 implemented (needs deploy), Phase 3
> implemented (needs TURN + manual media test), Phase 4 needs deploy/monitoring.**
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
app's browser clients for call media when STUN alone isn't enough.

---

## Phase 1 — Supabase backend (foundation) — DONE

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
- [x] Server-side analytics in `events`: `message_sent`, `file_uploaded`,
      `message_deleted` (server) and `page_view` (client).
- [x] `scripts/provision-admin.js` — dedicated admin account; refuses to
      promote an existing regular account (Phase 2 §2.2).
- [x] **Realtime broadcast** channel (`board`) for live posts, gated by RLS
      policies on `realtime.messages`.
- [x] **Soft delete:** posts set `deleted_at`/`hidden_from_user`;
      feeds + feeds RLS hide them; `list-all-messages` shows them for moderation.
- [x] **Privacy disclosure:** chat-app footer carries the retention clause.
- [x] **Backfill `profiles`:** `scripts/backfill-profiles.js`
      (`npm run backfill-profiles`) creates `profiles` rows for auth users
      created before the trigger. Verified idempotent against production.
- [x] **Table hardening:** sanity `CHECK` constraints in `SCHEMA_SQL`
      (`posts.text ≤ 500`, `posts.author` 1–40, `posts.timestamp > 0`,
      `post_files.file_size ≥ 0`, `profiles.username` 1–40). Data is normalized
      before each constraint is added; all idempotent.

---

## Phase 2 — Admin panel + analytics (separate repo) — IMPLEMENTED, deploy left

Located at **`whatapp-admin/`** (git-ignored here; its own repo, deployed on
Netlify).

### Done
- [x] `git init` as its own repo (initial commit present locally; add a remote
      and push when deploying).
- [x] `netlify.toml` — publish root + `netlify/functions`
- [x] `config.js` — SUPABASE_URL + anon key for the browser
- [x] `index.html` / `admin.js` — login + Overview (stats & bar charts),
      Users, Messages tabs. Vanilla JS (matches chat app; no build step).
- [x] `netlify/functions/_shared/supabase.js` — `requireAdmin()` verifies the
      caller's JWT server-side **and** checks `profiles.is_admin = true`.
- [x] `list-users.js`, `list-all-messages.js` (incl. `deleted_at` badge),
      `analytics-summary.js`
- [x] `package-lock.json` + local validation: every function loads against the
      real project and fails closed (`401 Authentication required` without a
      token). Import graph + env wiring confirmed.
- [x] README with `netlify dev` / env-var / deploy instructions.
- [x] Grant your account `is_admin = true` via `npm run provision-admin`
      (dedicated admin email, never a regular user's account).

### Remaining / decisions
- [ ] Deploy on Netlify + set env vars, custom domain (`admin.*`) — requires
      the site owner's Netlify account.
  ```bash
  netlify init
  netlify env:set SUPABASE_URL ...        # same project as the chat app
  netlify env:set SUPABASE_ANON_KEY ...
  netlify env:set SUPABASE_SERVICE_ROLE_KEY ...
  git push origin main
  ```
- [ ] (Optional) charting library / more analysis; admin UI polish

---

## Phase 3 — Voice & video calls — IMPLEMENTED, needs TURN + device test

- [x] WebRTC peer-to-peer media between two browsers.
- [x] Presence-driven **online bar** (private `calls` channel, RLS-gated;
      verified presence + broadcast against production).
- [x] Signaling over the shared Realtime `calls` channel (targeted broadcast
      payloads) — `call-invite → accept/decline/busy/cancel → offer → answer
      → ICE → end/error`. No separate signaling server.
- [x] Call state machine: `idle → outgoing/incoming (ring) → connecting →
      active → ended`.
- [x] UI: online list w/ call buttons, incoming call (accept/decline + WebAudio
      ringtone), ringing screen w/ auto-cancel, in-call panel (remote + local
      video, mute, camera toggle, hang up, duration timer), peer-offline hangup.
- [x] Call history to `events`: `call_started` / `call_received` /
      `call_ended` (with duration), client-side like `page_view`.
- [ ] **TURN fallback** for hostile NATs. STUN-only today (`CALL_ICE` in
      `public/app.js`). Recommend managed relay (Cloudflare Calls / Twilio),
      revisit self-hosting coturn at scale.
- [ ] Manual two-browser media test on real devices/NATs (getUserMedia/WebRTC
      can't run in CI). Transport + signaling are verified; the media handshake
      needs a human on two browsers.

---

## Phase 4 — Hosting & operations — PARTIAL

### Done
- [x] Chat app deploy config (`render.yaml`, Render free tier) + env checklist
- [x] Repo README with setup + Render deploy + scripts reference
- [x] Migration workflow documented (`migrations/README.md`): `SCHEMA_SQL` in
      `server.js` is the single idempotent source of truth; production changes
      via SQL editor or `supabase db push`.

### Remaining
- [ ] Admin deploy on Netlify (see Phase 2)
- [ ] Monitoring: Supabase dashboard basics + Sentry (free tier) in both repos
      once real users exist

---

## Env var checklist

| Service | Variables |
| --- | --- |
| Chat app (Render) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `MAX_FILE_SIZE_MB`, `MAX_FILES`, `STORAGE_BUCKET`, `SIGNED_URL_TTL_SECONDS` |
| Admin (Netlify) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (frontend), `SUPABASE_SERVICE_ROLE_KEY` (functions only) |

## Security checklist

- [x] RLS enabled + policies on **every** table (`posts`, `post_files`,
      `profiles`, `events` + `realtime.messages`); API layer rejects requests
      without a valid JWT (401). Per-statement RLS verified against the real
      project (non-admin boot test).
- [x] `SUPABASE_SERVICE_ROLE_KEY` only as a server-side env var, never in
      frontend code or committed
- [x] Admin routes verify `is_admin` server-side (Netlify functions), not just
      hidden in the UI — the scaffold's `requireAdmin()` does this
- [x] Storage bucket private; signed URLs for file access
- [x] Privacy/ToS disclosure for content retention (chat-app footer)
- [x] `.env` git-ignored in both repos