const express    = require("express");
const fs         = require("fs");
const path       = require("path");
const crypto     = require("crypto");
const multer     = require("multer");
const session    = require("express-session");
const Database   = require("better-sqlite3");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Configuration (overridable via environment) ─────────────
const DATA_DIR       = process.env.DATA_DIR    || path.join(__dirname, "data");
const UPLOADS_DIR    = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);
const AUTH_RATE_MAX  = Number(process.env.AUTH_RATE_MAX || 20);
const AUTH_RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_SECONDS || 15 * 60) * 1000;

app.set("trust proxy", 1);

// ── SQLite database ─────────────────────────────────────────
const DB_PATH = path.join(DATA_DIR, "whatapp.db");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id        TEXT PRIMARY KEY,
    text      TEXT DEFAULT '',
    author    TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    file_name    TEXT,
    file_original TEXT,
    file_size    INTEGER,
    file_mimetype TEXT
  );
  CREATE TABLE IF NOT EXISTS post_files (
    post_id       TEXT NOT NULL,
    file_name     TEXT PRIMARY KEY,
    file_original TEXT,
    file_size     INTEGER,
    file_mimetype TEXT,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
`);

// Add columns added after the app first shipped (idempotent).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing("users", "email", "email TEXT");
addColumnIfMissing("users", "reset_token_hash", "reset_token_hash TEXT");
addColumnIfMissing("users", "reset_expires", "reset_expires INTEGER");

// Migrate legacy single-file posts into post_files (idempotent).
db.exec(`
  INSERT INTO post_files (post_id, file_name, file_original, file_size, file_mimetype)
  SELECT id, file_name, file_original, file_size, file_mimetype
  FROM posts
  WHERE file_name IS NOT NULL
    AND file_name NOT IN (SELECT file_name FROM post_files);
`);

const insertPost      = db.prepare("INSERT INTO posts (id, text, author, timestamp) VALUES (@id, @text, @author, @timestamp)");
const insertPostFile  = db.prepare("INSERT INTO post_files (post_id, file_name, file_original, file_size, file_mimetype) VALUES (?, ?, ?, ?, ?)");
const deletePost      = db.prepare("DELETE FROM posts WHERE id = ?");
const getPost         = db.prepare("SELECT * FROM posts WHERE id = ?");
const getAllPosts     = db.prepare("SELECT * FROM posts ORDER BY timestamp ASC");
const getFilesForPost = db.prepare("SELECT * FROM post_files WHERE post_id = ?");
const getAllFiles     = db.prepare("SELECT * FROM post_files ORDER BY post_id, rowid");
const insertUser      = db.prepare("INSERT INTO users (username, password, email) VALUES (?, ?, ?)");
const getUser         = db.prepare("SELECT * FROM users WHERE username = ?");
const getUserByReset  = db.prepare("SELECT * FROM users WHERE reset_token_hash = ?");
const setResetToken   = db.prepare("UPDATE users SET reset_token_hash = ?, reset_expires = ? WHERE username = ?");
const clearResetToken = db.prepare("UPDATE users SET reset_token_hash = NULL, reset_expires = NULL WHERE username = ?");
const setPassword     = db.prepare("UPDATE users SET password = ? WHERE username = ?");

// ── Uploads directory ─────────────────────────────────────────
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer config ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|js|ts|py|html|css|mp3|wav|ogg|m4a|mp4|webm|zip)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("File type not allowed"));
    }
  }
});

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "frame-ancestors 'none'");
  next();
});
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(session({
  secret:            SESSION_SECRET,
  resave:            true,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// ── Auth helpers ──────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key  = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${key}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(":");
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return derived === key;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required." });
  }
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
const authLimiter = rateLimit({ windowMs: AUTH_RATE_WINDOW_MS, max: AUTH_RATE_MAX });

// ── Password reset helpers ──────────────────────────────────
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function sendEmail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = process.env.RESEND_FROM || "Whatapp <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ from, to, subject, text })
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ── Auth routes ───────────────────────────────────────────────
app.post("/api/register", authLimiter, (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  const name = username.trim().toLowerCase();
  if (name.length < 2 || name.length > 20) {
    return res.status(400).json({ error: "Username must be 2–20 characters." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }
  const mail = (email || "").trim().toLowerCase();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  const existing = getUser.get(name);
  if (existing) {
    return res.status(409).json({ error: "Username already taken." });
  }

  try {
    insertUser.run(name, hashPassword(password), mail || null);
  } catch (err) {
    return res.status(500).json({ error: "Failed to create account." });
  }

  req.session.userId   = name;
  req.session.username = name;
  res.status(201).json({ username: name });
});

app.post("/api/login", authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const name = (username || "").trim().toLowerCase();

  const user = getUser.get(name);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  req.session.userId   = name;
  req.session.username = name;
  res.json({ username: name });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Password reset ───────────────────────────────────────────
app.post("/api/reset/request", authLimiter, async (req, res) => {
  const username = ((req.body || {}).username || "").trim().toLowerCase();
  const user = getUser.get(username);

  // Always respond ok — never reveal which usernames exist.
  if (user && user.email) {
    const token = crypto.randomBytes(32).toString("hex");
    setResetToken.run(sha256(token), Date.now() + 60 * 60 * 1000, username);
    const link = `${req.protocol}://${req.get("host")}/?reset=${token}`;
    const sent = await sendEmail(
      user.email,
      "Whatapp — reset your password",
      `Use this link to set a new password (valid for 60 minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`
    );
    if (!sent) console.log(`\n[password reset] ${link}\n`);
  }

  res.json({ ok: true });
});

app.post("/api/reset/confirm", (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: "Reset token and new password are required." });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }
  const user = getUserByReset.get(sha256(token));
  if (!user || !user.reset_expires || user.reset_expires < Date.now()) {
    return res.status(400).json({ error: "Reset link is invalid or expired." });
  }
  setPassword.run(hashPassword(newPassword), user.username);
  clearResetToken.run(user.username);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ user: null });
  }
  res.json({ user: { username: req.session.username } });
});

// ── Post helpers ──────────────────────────────────────────────
function rowToPost(row, files = []) {
  const post = {
    id:        row.id,
    text:      row.text,
    author:    row.author,
    timestamp: row.timestamp,
    files:     files.map(f => ({
      filename: f.file_name,
      original: f.file_original,
      size:     f.file_size,
      mimetype: f.file_mimetype
    }))
  };
  return post;
}

// ── GET /api/posts ────────────────────────────────────────────
app.get("/api/posts", requireAuth, (req, res) => {
  const rows = getAllPosts.all();
  const filesById = new Map();
  for (const f of getAllFiles.all()) {
    const list = filesById.get(f.post_id) || [];
    list.push(f);
    filesById.set(f.post_id, list);
  }
  res.json(rows.map(row => rowToPost(row, filesById.get(row.id) || [])));
});

// ── POST /api/posts ───────────────────────────────────────────
app.post("/api/posts", requireAuth, upload.array("files", 10), (req, res) => {
  const text  = (req.body.text || "").trim();
  const files = req.files || [];

  if (!text && files.length === 0) {
    return res.status(400).json({ error: "Post text or a file is required." });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: "Post text must be 500 characters or fewer." });
  }

  const newPost = {
    id:        crypto.randomUUID(),
    text:      text,
    author:    req.session.username,
    timestamp: Date.now(),
    files:     files.map(f => ({
      filename: f.filename,
      original: f.originalname,
      size:     f.size,
      mimetype: f.mimetype
    }))
  };

  try {
    insertPost.run({
      id:        newPost.id,
      text:      newPost.text,
      author:    newPost.author,
      timestamp: newPost.timestamp
    });
    for (const f of files) {
      insertPostFile.run(newPost.id, f.filename, f.originalname, f.size, f.mimetype);
    }
  } catch (err) {
    for (const f of files) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, f.filename)); } catch (_) {}
    }
    return res.status(500).json({ error: "Failed to save post." });
  }

  broadcast("post-created", newPost);
  res.status(201).json(newPost);
});

// ── DELETE /api/posts/:id ─────────────────────────────────────
app.delete("/api/posts/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const row = getPost.get(id);
  if (!row) {
    return res.status(404).json({ error: "Post not found." });
  }
  if (row.author !== req.session.username) {
    return res.status(403).json({ error: "You can only erase your own posts." });
  }

  const files = getFilesForPost.all(id);
  try {
    deletePost.run(id);
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete post." });
  }

  for (const f of files) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f.file_name)); } catch (_) {}
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
app.listen(PORT, () => {
  console.log(`\n✦  Whatapp running → http://localhost:${PORT}`);
  console.log(`   Database          → ${DB_PATH}\n`);
});
