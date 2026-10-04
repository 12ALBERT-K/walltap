require("dotenv").config();
const express    = require("express");
const path       = require("path");
const crypto     = require("crypto");
const multer     = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { Pool }   = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Configuration (overridable via environment) ─────────────
const SUPABASE_URL              = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DATABASE_URL              = process.env.DATABASE_URL || "";
const STORAGE_BUCKET            = process.env.STORAGE_BUCKET || "uploads";
const MAX_FILE_SIZE_MB          = Number(process.env.MAX_FILE_SIZE_MB || 15);
const MAX_FILES                 = Number(process.env.MAX_FILES || 5);
const SIGNED_URL_TTL_SECONDS    = Number(process.env.SIGNED_URL_TTL_SECONDS || 60 * 60 * 24 * 7);

const REQUIRED = { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY };
const MISSING  = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);

app.set("trust proxy", 1);

// ── Supabase admin client (server-side only) ────────────────
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

let ready = false;

// ── Schema bootstrap ────────────────────────────────────────
// DDL can't go through the Supabase REST client, so we open a
// short-lived Postgres connection with DATABASE_URL. Optional —
// if it's missing we assume the tables already exist.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS posts (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL DEFAULT '',
    author     TEXT NOT NULL,
    author_id  TEXT,
    timestamp  BIGINT NOT NULL
  );
  -- Soft delete: deleted posts stay in the DB (moderation retention) but are
  -- hidden from feeds and clients. Only the admin view reads them.
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden_from_user boolean NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS post_files (
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    file_name     TEXT PRIMARY KEY,
    file_original TEXT,
    file_size     BIGINT,
    file_mimetype TEXT
  );
  CREATE INDEX IF NOT EXISTS post_files_post_id_idx ON post_files(post_id);
  ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE post_files ENABLE ROW LEVEL SECURITY;

  -- profiles: app-specific fields on top of auth.users.
  -- A trigger keeps it in sync with new signups automatically.
  CREATE TABLE IF NOT EXISTS profiles (
    id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username   text UNIQUE NOT NULL,
    is_admin   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

  -- Assigns profiles.username on signup.
  --
  -- username is UNIQUE, and a plain INSERT ... ON CONFLICT (id) DO NOTHING does
  -- NOT cover that: a repeated display_name raises unique_violation, the trigger
  -- aborts, and signup fails with an opaque "Database error creating new user".
  -- Since usernames are the primary identity, that collision is the common case
  -- rather than an edge case, so fall back to a numeric suffix until free.
  CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
  AS $$
  DECLARE
    base      text;
    candidate text;
    suffix    integer := 0;
  BEGIN
    -- A row may already exist (backfill, or a re-fired trigger). Leave it be.
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id) THEN
      RETURN NEW;
    END IF;

    base := LEFT(COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
      NULLIF(SPLIT_PART(COALESCE(NEW.email, ''), '@', 1), ''),
      'user'
    ), 40);

    candidate := base;
    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = candidate) LOOP
      suffix    := suffix + 1;
      candidate := LEFT(base, 40 - length(suffix::text) - 1) || suffix::text;
    END LOOP;

    INSERT INTO public.profiles (id, username) VALUES (NEW.id, candidate);
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

  -- events: analitycs/activity log written by the chat app + admin reads.
  CREATE TABLE IF NOT EXISTS events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    user_id    uuid REFERENCES profiles(id) ON DELETE SET NULL,
    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at);
  CREATE INDEX IF NOT EXISTS events_event_type_idx ON events(event_type);
  ALTER TABLE events ENABLE ROW LEVEL SECURITY;

  -- admin_profiles: exposes auth.users.email to admins only.
  -- A plain view runs with its OWNER's privileges and so bypasses RLS, while
  -- Supabase grants every privilege on new public objects to anon/authenticated.
  -- Without the REVOKE below, the entire user list (emails + is_admin) is
  -- readable by anyone holding the public anon key. Must stay directly after
  -- this CREATE, because CREATE OR REPLACE preserves grants but a DROP/recreate
  -- would reset them to the Supabase defaults.
  CREATE OR REPLACE VIEW public.admin_profiles AS
    SELECT p.id, p.username, p.is_admin, p.created_at, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id;
  REVOKE ALL ON public.admin_profiles FROM anon, authenticated;
  GRANT SELECT ON public.admin_profiles TO service_role;

  -- RLS policies (defense in depth; the server itself uses the service role).
  -- posts policies are DROP+CREATE so definition changes (e.g. soft-delete
  -- visibility) apply on every boot without manual migration.
  DROP POLICY IF EXISTS "posts readable by authenticated" ON posts;
  CREATE POLICY "posts readable by authenticated" ON posts FOR SELECT USING (auth.role() = 'authenticated' AND deleted_at IS NULL);
  DROP POLICY IF EXISTS "posts insert own" ON posts;
  -- author_id must be present and owned: the old "author_id IS NULL OR ..." form
  -- let an UNAUTHENTICATED caller insert posts with a null author, because
  -- auth.uid() is NULL for anon and the null branch short-circuits to true.
  CREATE POLICY "posts insert own" ON posts FOR INSERT WITH CHECK (author_id IS NOT NULL AND auth.uid() = author_id::uuid);
  DROP POLICY IF EXISTS "posts update own" ON posts;
  CREATE POLICY "posts update own" ON posts FOR UPDATE USING (auth.uid() = author_id::uuid);
  DROP POLICY IF EXISTS "posts delete own" ON posts;
  CREATE POLICY "posts delete own" ON posts FOR DELETE USING (auth.uid() = author_id::uuid);

  -- Privilege escalation guard: RLS is row-level only, so "profiles update own"
  -- gated WHICH ROW a user could touch but not WHICH COLUMNS. Any signed-in user
  -- could therefore PATCH their own row to is_admin = true and walk straight into
  -- the admin dashboard (every email, every message incl. soft-deleted). Fix it
  -- with column privileges, not a RLS check — a WITH CHECK cannot see the old row,
  -- so "is_admin = false" would also lock admins out of editing their own profile.
  -- Re-applied every boot so a drifted grant self-heals. admins can still be
  -- promoted/demoted with the service role (npm run provision-admin).
  DROP POLICY IF EXISTS "profiles update own" ON profiles;
  CREATE POLICY "profiles update own" ON profiles FOR UPDATE USING (auth.uid() = id);
  REVOKE UPDATE ON public.profiles FROM anon, authenticated;
  GRANT UPDATE (username) ON public.profiles TO authenticated;

  -- Realtime broadcast authorization: any signed-in user may join the "board"
  -- channel and receive (and send) broadcast messages on it.
  -- (Required because Realtime Authorization is enforced by default; the client
  --  joins with private:true so these RLS policies are the gate.)
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='realtime' AND tablename='messages' AND policyname='authenticated can receive broadcasts') THEN
      CREATE POLICY "authenticated can receive broadcasts" ON realtime.messages FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='realtime' AND tablename='messages' AND policyname='authenticated can send broadcasts') THEN
      CREATE POLICY "authenticated can send broadcasts" ON realtime.messages FOR INSERT TO authenticated WITH CHECK (true);
    END IF;
  END
  $$;

  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='post_files' AND policyname='post_files readable by authenticated') THEN
      CREATE POLICY "post_files readable by authenticated" ON post_files FOR SELECT USING (auth.role() = 'authenticated');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles readable by authenticated') THEN
      CREATE POLICY "profiles readable by authenticated" ON profiles FOR SELECT USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles insert own') THEN
      CREATE POLICY "profiles insert own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='events' AND policyname='events insert own') THEN
      CREATE POLICY "events insert own" ON events FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='events' AND policyname='events readable own') THEN
      CREATE POLICY "events readable own" ON events FOR SELECT USING (auth.uid() = user_id);
    END IF;

    -- Presence needs a SELECT policy on realtime.presences in addition to the
    -- realtime.messages policies above (used by the calls channel in Phase 3).
    -- Note: current Supabase realtime keeps presence in realtime.messages too,
    -- so guard the presences policy with an existence check (both layouts work).
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='realtime' AND tablename='presences') THEN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='realtime' AND tablename='presences' AND policyname='authenticated can see presences') THEN
        CREATE POLICY "authenticated can see presences" ON realtime.presences FOR SELECT TO authenticated USING (true);
      END IF;
    END IF;
  END
  $$;

  -- Table hardening: sanity CHECK constraints (idempotent). Data is normalized
  -- first so legacy rows can never block the constraint from being added.
  DO $$
  BEGIN
    UPDATE posts SET text = LEFT(text, 500) WHERE char_length(text) > 500;
    UPDATE posts SET author = LEFT(author, 40) WHERE char_length(author) > 40;
    UPDATE posts SET timestamp = 1 WHERE timestamp IS NOT NULL AND timestamp < 1;
    UPDATE post_files SET file_size = NULL WHERE file_size IS NOT NULL AND file_size < 0;
    UPDATE profiles SET username = LEFT(username, 40) WHERE char_length(username) > 40;
    UPDATE profiles SET username = 'user' WHERE char_length(username) < 1;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_text_length_ck') THEN
      ALTER TABLE posts ADD CONSTRAINT posts_text_length_ck CHECK (char_length(text) <= 500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_author_length_ck') THEN
      ALTER TABLE posts ADD CONSTRAINT posts_author_length_ck CHECK (char_length(author) BETWEEN 1 AND 40);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_timestamp_pos_ck') THEN
      ALTER TABLE posts ADD CONSTRAINT posts_timestamp_pos_ck CHECK (timestamp > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_files_size_nonneg_ck') THEN
      ALTER TABLE post_files ADD CONSTRAINT post_files_size_nonneg_ck CHECK (file_size IS NULL OR file_size >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_username_length_ck') THEN
      ALTER TABLE profiles ADD CONSTRAINT profiles_username_length_ck CHECK (char_length(username) BETWEEN 1 AND 40);
    END IF;
  END
  $$;
`;

async function initSchema() {
  if (!DATABASE_URL) {
    console.log("   Schema        → skipped (no DATABASE_URL; assuming tables exist)");
    return;
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("sslmode=") ? undefined : { rejectUnauthorized: false }
  });
  try {
    await pool.query(SCHEMA_SQL);
    console.log("   Schema        → ensured");
  } finally {
    await pool.end();
  }
}

async function ensureBucket() {
  if (!supabase) return;
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
  // "already exists" is the expected error on every boot after the first.
  if (error && !/already exists/i.test(error.message)) throw error;
  // Enforce privacy even if the bucket was previously created public.
  const { error: updErr } = await supabase.storage.updateBucket(STORAGE_BUCKET, { public: false });
  if (updErr) throw updErr;
  console.log(`   Storage       → bucket "${STORAGE_BUCKET}" ready (private)`);
}

// ── Multer config (in-memory; files stream straight to Storage) ─
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|js|ts|py|html|css|mp3|wav|ogg|m4a|mp4|webm|zip)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EXT.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      // Not a MulterError, so it reaches the generic branch below. statusCode is
      // what turns this into a 400 instead of a 500 — a rejected upload is the
      // caller's mistake, not a server fault, and the client renders the message.
      const err = new Error("File type not allowed");
      err.statusCode = 400;
      cb(err);
    }
  }
});

// ── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https://*.supabase.co; " +
    "media-src 'self' blob: https://*.supabase.co; " +
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co; " +
    "object-src 'none'; " +
    "frame-ancestors 'none'");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Public client config — the browser only ever sees the anon key.
app.get("/config.js", (req, res) => {
  res.type("application/javascript");
  res.send(
    `window.SUPABASE_URL=${JSON.stringify(SUPABASE_URL)};` +
    `window.SUPABASE_ANON_KEY=${JSON.stringify(SUPABASE_ANON_KEY)};`
  );
});

// ── Auth helpers ──────────────────────────────────────────────
function displayName(user) {
  const md = user.user_metadata || {};
  const raw = md.display_name || md.username || (user.email || "").split("@")[0] || "user";
  return String(raw).trim().slice(0, 40) || "user";
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (typeof req.query.token === "string") return req.query.token;
  return "";
}

async function requireAuth(req, res, next) {
  if (!ready) return res.status(503).json({ error: "Server is not configured yet." });
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required." });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  req.user   = data.user;
  req.author = displayName(data.user);
  next();
}

// ── Rate limiting (in-memory, fixed window) ─────────────────
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const key  = req.ip;
    const now  = Date.now();
    const curr = hits.get(key);
    if (!curr || curr.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    curr.count++;
    if (curr.count > max) {
      res.setHeader("Retry-After", Math.ceil((curr.reset - now) / 1000));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}
const postLimiter  = rateLimit({ windowMs: 60 * 1000, max: 30 });
// Reads are cheap for the caller but not for us: every attachment on a page
// costs a Storage signing round-trip, so an unbounded GET is the easiest way to
// take the whole instance down. Generous enough for a client polling the feed.
const getLimiter   = rateLimit({ windowMs: 60 * 1000, max: 120 });
const refreshLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Feed paging. The default page is deliberately small: it is also the number of
// Storage signing calls a single page load can cost.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;
const MAX_REFRESH_IDS   = 200;

// ── Storage helpers ───────────────────────────────────────────
function signUrl(name) {
  if (!name) return Promise.resolve("");
  return supabase.storage.from(STORAGE_BUCKET).createSignedUrl(name, SIGNED_URL_TTL_SECONDS)
    .then(({ data, error }) => {
      if (error) { console.error("createSignedUrl failed:", error.message); return ""; }
      return data.signedUrl;
    });
}

// ── Activity logging (failsafe — never breaks a user request) ──
async function logEvent(event_type, user_id, metadata = {}) {
  try {
    // supabase-js resolves with { error } rather than throwing, so a try/catch
    // alone silently swallows every failure — check the result explicitly.
    const { error } = await supabase.from("events").insert({ event_type, user_id, metadata });
    if (error) console.error(`logEvent(${event_type}) failed:`, error.message);
  } catch (err) {
    console.error(`logEvent(${event_type}) threw:`, err.message);
  }
}

// ── Post helpers ──────────────────────────────────────────────
async function rowToPost(row, files = []) {
  const urls = await Promise.all(files.map(f => signUrl(f.file_name)));
  return {
    id:        row.id,
    text:      row.text,
    author:    row.author,
    authorId:  row.author_id,
    timestamp: row.timestamp,
    files:     files.map((f, i) => ({
      filename: f.file_name,
      original: f.file_original,
      size:     f.file_size,
      mimetype: f.file_mimetype,
      url:      urls[i] || ""
    }))
  };
}

// Only the post_files belonging to the page being rendered. Selecting the whole
// table is what used to hit PostgREST's 1000-row ceiling and silently truncate
// attachments on large boards.
async function fetchFilesByPost(postIds) {
  const byId = new Map();
  if (!postIds.length) return byId;
  const { data, error } = await supabase.from("post_files").select("*").in("post_id", postIds);
  if (error) throw error;
  for (const f of data) {
    const list = byId.get(f.post_id) || [];
    list.push(f);
    byId.set(f.post_id, list);
  }
  return byId;
}

// ── GET /api/posts ────────────────────────────────────────────
// Paged: ?limit=<n> (default 50, max 200) and ?before=<timestamp> for older
// pages. The newest page comes back by default — ordering ascending and then
// truncating would show a new visitor the 50 *oldest* posts on the board.
// Response stays a plain array, oldest-first, to match the bottom-anchored feed.
app.get("/api/posts", getLimiter, requireAuth, async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    const before = Number.parseInt(req.query.before, 10);
    const hasBefore = Number.isFinite(before) && before > 0;

    let q = supabase
      .from("posts")
      .select("*")
      .is("deleted_at", null)
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (hasBefore) q = q.lt("timestamp", before);

    const { data: rows, error: postErr } = await q;
    if (postErr) throw postErr;
    rows.reverse();

    const filesById = await fetchFilesByPost(rows.map(r => r.id));
    res.json(await Promise.all(rows.map(row => rowToPost(row, filesById.get(row.id) || []))));
  } catch (err) {
    console.error("GET /api/posts failed:", err.stack || err.message);
    res.status(500).json({ error: "Failed to load posts." });
  }
});

// ── POST /api/posts/refresh-files ─────────────────────────────
// Signed URLs expire (SIGNED_URL_TTL_SECONDS, default 7 days) and the browser
// only learns a URL is dead when the request 403s. The feed calls this to mint
// fresh URLs for posts whose attachments stopped loading, so old attachments
// recover instead of breaking permanently.
app.post("/api/posts/refresh-files", refreshLimiter, requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids)
      ? [...new Set(req.body.ids.filter(v => typeof v === "string"))].slice(0, MAX_REFRESH_IDS)
      : [];
    if (!ids.length) return res.json({ files: [] });

    const { data: rows, error: postErr } = await supabase
      .from("posts")
      .select("id")
      .in("id", ids)
      .is("deleted_at", null);
    if (postErr) throw postErr;
    if (!rows.length) return res.json({ files: [] });

    const { data: fileRows, error: fileErr } = await supabase
      .from("post_files")
      .select("post_id, file_name")
      .in("post_id", rows.map(r => r.id));
    if (fileErr) throw fileErr;

    const files = await Promise.all((fileRows || []).map(async f => ({
      post_id: f.post_id,
      filename: f.file_name,
      url: await signUrl(f.file_name)
    })));
    res.json({ files });
  } catch (err) {
    console.error("POST /api/posts/refresh-files failed:", err.message);
    res.status(500).json({ error: "Failed to refresh attachments." });
  }
});

// ── POST /api/posts ───────────────────────────────────────────
app.post("/api/posts", postLimiter, requireAuth, upload.array("files", MAX_FILES), async (req, res) => {
  const text  = (req.body.text || "").trim();
  const files = req.files || [];

  if (!text && files.length === 0) {
    return res.status(400).json({ error: "Post text or a file is required." });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: "Post text must be 500 characters or fewer." });
  }

  const id        = crypto.randomUUID();
  const timestamp = Date.now();
  const uploaded  = [];

  try {
    // 1. Upload every attachment to Supabase Storage.
    for (const f of files) {
      const name = crypto.randomUUID() + path.extname(f.originalname).toLowerCase();
      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(name, f.buffer, { contentType: f.mimetype, upsert: false });
      if (error) throw error;
      uploaded.push({ name, original: f.originalname, size: f.size, mimetype: f.mimetype });
    }

    // 2. Insert the post row.
    const { error: postErr } = await supabase.from("posts").insert({
      id,
      text,
      author:    req.author,
      author_id: req.user.id,
      timestamp
    });
    if (postErr) throw postErr;

    // 3. Insert the file rows.
    if (uploaded.length) {
      const { error: fileErr } = await supabase.from("post_files").insert(
        uploaded.map(u => ({
          post_id:       id,
          file_name:     u.name,
          file_original: u.original,
          file_size:     u.size,
          file_mimetype: u.mimetype
        }))
      );
      if (fileErr) throw fileErr;
    }

    const fileOuts = uploaded.map(u => ({
      filename: u.name,
      original: u.original,
      size:     u.size,
      mimetype: u.mimetype
    }));
    const urls = await Promise.all(uploaded.map(u => signUrl(u.name)));

    const newPost = {
      id,
      text,
      author:    req.author,
      authorId:  req.user.id,
      timestamp,
      files:     fileOuts.map((f, i) => ({ ...f, url: urls[i] || "" }))
    };

    logEvent("message_sent", req.user.id, { text, file_count: files.length, id });
    if (files.length) {
      logEvent("file_uploaded", req.user.id, { id, file_count: files.length });
    }

    broadcast("post-created", newPost);
    res.status(201).json(newPost);

  } catch (err) {
    console.error("POST /api/posts failed:", err.message);
    if (uploaded.length) {
      try { await supabase.storage.from(STORAGE_BUCKET).remove(uploaded.map(u => u.name)); } catch (_) {}
    }
    res.status(500).json({ error: "Failed to save post." });
  }
});

// ── DELETE /api/posts/:id ─────────────────────────────────────
app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  // deleted_at IS NULL: a post the caller already erased is gone as far as they
  // are concerned, so re-deleting must 404 rather than re-stamp deleted_at,
  // re-log message_deleted and re-broadcast a delete for a vanished post.
  const { data: row, error: getErr } = await supabase
    .from("posts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: "Failed to delete post." });
  if (!row)   return res.status(404).json({ error: "Post not found." });
  if (row.author_id && row.author_id !== req.user.id) {
    return res.status(403).json({ error: "You can only erase your own posts." });
  }
  // Already gone. Answer 404 rather than re-applying, so a retried request
  // cannot overwrite the original deleted_at (the audit trail) or fire a
  // second message_deleted event / post-deleted broadcast.
  if (row.deleted_at) return res.status(404).json({ error: "Post not found." });

  const { error: softErr } = await supabase
    .from("posts")
    .update({ deleted_at: new Date().toISOString(), hidden_from_user: true })
    .eq("id", id);
  if (softErr) return res.status(500).json({ error: "Failed to delete post." });

  logEvent("message_deleted", req.user.id, { id, soft: true });
  broadcast("post-deleted", { id });
  res.status(204).end();
});

// ── Realtime broadcast (replaces SSE) ─────────────────────────
// The server (service-role client) broadcasts on a shared "board" channel;
// every signed-in browser subscribes to the same channel with private:true,
// so the realtime.messages RLS policies (see SCHEMA_SQL) gate access.
let boardChannel = null;
let boardReady   = false;

function connectRealtime() {
  if (!supabase) return;
  boardChannel = supabase.channel("board");
  boardChannel.subscribe((status) => {
    boardReady = status === "SUBSCRIBED";
    if (!boardReady) console.warn("Realtime channel subscribed:", status);
  });
}

function broadcast(event, data) {
  if (!boardReady || !boardChannel) return;
  try {
    boardChannel.send({ type: "broadcast", event, payload: data });
  } catch (_) {}
}

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.` });
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILES}.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    // Errors we raised deliberately (e.g. a rejected upload) carry a status.
    // Anything else is a genuine fault: log the detail, return a generic 500 so
    // internal messages (and anything in them) never reach the client.
    const status = Number(err.statusCode) || 500;
    if (status >= 500) console.error("Unhandled request error:", err.message);
    const msg = status < 500 && err instanceof Error ? err.message : "Internal server error.";
    return res.status(status).json({ error: msg });
  }
  next();
});

// ── Start ─────────────────────────────────────────────────────
async function main() {
  if (MISSING.length) {
    console.warn(`\n⚠  Missing environment variables: ${MISSING.join(", ")}`);
    console.warn("   The UI will load, but the API returns 503 until they are set.\n");
  } else {
    try {
      await initSchema();
      await ensureBucket();
      connectRealtime();
      ready = true;
    } catch (err) {
      console.error(`\n⚠  Startup check failed: ${err.message}\n`);
    }
  }

  app.listen(PORT, () => {
    console.log(`\n✦  Walltap running → http://localhost:${PORT}`);
    console.log(`   Backend       → Supabase ${SUPABASE_URL ? "configured" : "(not configured)"}\n`);
  });
}

main();
