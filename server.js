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
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: true });
  // "already exists" is the expected error on every boot after the first.
  if (error && !/already exists/i.test(error.message)) throw error;
  console.log(`   Storage       → bucket "${STORAGE_BUCKET}" ready`);
}

// ── Multer config (in-memory; files stream straight to Storage) ─
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|js|ts|py|html|css|mp3|wav|ogg|m4a|mp4|webm|zip)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("File type not allowed"));
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
    "connect-src 'self' https://*.supabase.co; " +
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
const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ── Storage helpers ───────────────────────────────────────────
function publicUrl(name) {
  return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name).data.publicUrl;
}

// ── Post helpers ──────────────────────────────────────────────
function rowToPost(row, files = []) {
  return {
    id:        row.id,
    text:      row.text,
    author:    row.author,
    authorId:  row.author_id,
    timestamp: row.timestamp,
    files:     files.map(f => ({
      filename: f.file_name,
      original: f.file_original,
      size:     f.file_size,
      mimetype: f.file_mimetype,
      url:      publicUrl(f.file_name)
    }))
  };
}

async function fetchFilesByPost() {
  const { data, error } = await supabase.from("post_files").select("*");
  if (error) throw error;
  const byId = new Map();
  for (const f of data) {
    const list = byId.get(f.post_id) || [];
    list.push(f);
    byId.set(f.post_id, list);
  }
  return byId;
}

// ── GET /api/posts ────────────────────────────────────────────
app.get("/api/posts", requireAuth, async (req, res) => {
  try {
    const [{ data: rows, error: postErr }, filesById] = await Promise.all([
      supabase.from("posts").select("*").order("timestamp", { ascending: true }),
      fetchFilesByPost()
    ]);
    if (postErr) throw postErr;
    res.json(rows.map(row => rowToPost(row, filesById.get(row.id) || [])));
  } catch (err) {
    console.error("GET /api/posts failed:", err.message);
    res.status(500).json({ error: "Failed to load posts." });
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

    const newPost = {
      id,
      text,
      author:    req.author,
      authorId:  req.user.id,
      timestamp,
      files:     uploaded.map(u => ({
        filename: u.name,
        original: u.original,
        size:     u.size,
        mimetype: u.mimetype,
        url:      publicUrl(u.name)
      }))
    };

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

  const { data: row, error: getErr } = await supabase.from("posts").select("*").eq("id", id).maybeSingle();
  if (getErr) return res.status(500).json({ error: "Failed to delete post." });
  if (!row)   return res.status(404).json({ error: "Post not found." });
  if (row.author_id && row.author_id !== req.user.id) {
    return res.status(403).json({ error: "You can only erase your own posts." });
  }

  const { data: files } = await supabase.from("post_files").select("*").eq("post_id", id);

  const { error: delErr } = await supabase.from("posts").delete().eq("id", id);
  if (delErr) return res.status(500).json({ error: "Failed to delete post." });

  if (files && files.length) {
    try { await supabase.storage.from(STORAGE_BUCKET).remove(files.map(f => f.file_name)); } catch (_) {}
  }

  broadcast("post-deleted", { id });
  res.status(204).end();
});

// ── SSE ───────────────────────────────────────────────────────
const sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch (_) { }
  });
  sseClients.slice().forEach(res => {
    if (res.destroyed || res.closed) {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    }
  });
}

const ssePing = setInterval(() => {
  sseClients.forEach(res => {
    try { res.write(":ping\n\n"); } catch (_) { }
  });
}, 30000);

app.get("/api/events", requireAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":connected\n\n");
  sseClients.push(res);

  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    const msg = err instanceof Error ? err.message : "Internal server error.";
    return res.status(500).json({ error: msg });
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
      ready = true;
    } catch (err) {
      console.error(`\n⚠  Startup check failed: ${err.message}\n`);
    }
  }

  app.listen(PORT, () => {
    console.log(`\n✦  Whatapp running → http://localhost:${PORT}`);
    console.log(`   Backend       → Supabase ${SUPABASE_URL ? "configured" : "(not configured)"}\n`);
  });
}

main();
