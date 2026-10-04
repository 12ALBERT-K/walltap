// End-to-end API test against a live server + live Supabase.
// Creates throwaway users, exercises the real HTTP endpoints, then cleans up.
//
//   node scripts/e2e.js            (expects the server already running on PORT)
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const PORT = process.env.E2E_PORT || process.env.PORT || 3999;
// Pinned to IPv4: the rate-limit burst below uses [::1] for an isolated key, and
// "localhost" may resolve to either family.
const BASE = `http://127.0.0.1:${PORT}`;
const BURST = `http://[::1]:${PORT}`;
const STAMP = Date.now();
const TESTERS = [];

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  PASS  " + m); };
const no = (m) => { fail++; console.log("  FAIL  " + m); };
const check = (cond, m) => cond ? ok(m) : no(m);

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

async function makeUser(label) {
  const email = `e2e-${label}-${STAMP}@walltap.test`;
  const password = "e2e-" + STAMP + "-pw";
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: `e2e${label}` },
  });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`signIn(${label}): ${sErr.message}`);
  TESTERS.push(data.user.id);
  return { id: data.user.id, email, token: sess.session.access_token, name: `e2e${label}` };
}

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

async function cleanup() {
  const { data: mine } = await admin.from("posts").select("id").in("author_id", TESTERS);
  for (const p of mine || []) {
    const { data: fs2 } = await admin.from("post_files").select("file_name").eq("post_id", p.id);
    if ((fs2 || []).length) await admin.storage.from("uploads").remove(fs2.map(f => f.file_name));
    await admin.from("posts").delete().eq("id", p.id);
  }
  if (TESTERS.length) {
    await admin.from("events").delete().in("user_id", TESTERS);
    for (const id of TESTERS) await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  return (mine || []).length;
}

async function main() {
  console.log(`\nTarget: ${BASE}\n`);
  const A = await makeUser("a");
  const B = await makeUser("b");

  console.log("Auth gate");
  let r = await fetch(`${BASE}/api/posts`);
  check(r.status === 401, `GET /api/posts unauthenticated -> 401 (got ${r.status})`);
  r = await fetch(`${BASE}/api/posts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  check(r.status === 401, `POST /api/posts unauthenticated -> 401 (got ${r.status})`);
  r = await fetch(`${BASE}/api/posts`, { headers: auth(A) });
  check(r.status === 200, `GET /api/posts authenticated -> 200 (got ${r.status})`);

  console.log("\nCreate + read");
  r = await fetch(`${BASE}/api/posts`, {
    method: "POST", headers: { ...auth(A), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from e2e" }),
  });
  const post = await r.json().catch(() => ({}));
  check(r.status === 201, `POST text -> 201 (got ${r.status})`);
  check(!!post.id, "response carries an id");
  check(post.authorId === A.id, "authorId is the caller");
  check(post.author === "e2ea", `author derived from metadata (got ${JSON.stringify(post.author)})`);

  r = await fetch(`${BASE}/api/posts`, { headers: auth(B) });
  const feed = await r.json();
  check(Array.isArray(feed) && feed.some(p => p.id === post.id), "post is visible to another user");

  console.log("\nValidation");
  r = await fetch(`${BASE}/api/posts`, {
    method: "POST", headers: { ...auth(A), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(501) }),
  });
  check(r.status === 400, `501-char text -> 400 (got ${r.status})`);

  r = await fetch(`${BASE}/api/posts`, {
    method: "POST", headers: { ...auth(A), "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  check(r.status === 400, `whitespace-only text -> 400 (got ${r.status})`);

  console.log("\nFile upload");
  const fd = new FormData();
  fd.append("text", "with a file");
  fd.append("files", new Blob(["hello file contents"], { type: "text/plain" }), "notes.txt");
  r = await fetch(`${BASE}/api/posts`, { method: "POST", headers: auth(A), body: fd });
  const withFile = await r.json().catch(() => ({}));
  check(r.status === 201, `POST with .txt -> 201 (got ${r.status})`);
  check((withFile.files || []).length === 1, "one attachment recorded");
  const file = (withFile.files || [])[0];
  check(!!file.url && file.url.includes("token="), "attachment has a signed Storage URL");
  if (file && file.url) {
    const fr = await fetch(file.url);
    check(fr.status === 200, `signed URL downloads -> 200 (got ${fr.status})`);
    const body = await fr.text();
    check(body === "hello file contents", "downloaded bytes match what was uploaded");
  }
  check(file && /^[0-9a-f-]{36}\.txt$/.test(file.filename), "stored name is a uuid, original ext kept");

  const bad = new FormData();
  bad.append("text", "bad file");
  bad.append("files", new Blob(["x"], { type: "application/x-msdownload" }), "evil.exe");
  r = await fetch(`${BASE}/api/posts`, { method: "POST", headers: auth(A), body: bad });
  const badBody = await r.json().catch(() => ({}));
  check(r.status === 400 && /not allowed/i.test(badBody.error || ""),
    `disallowed .exe -> 400 with a clear message (status ${r.status}: ${JSON.stringify(badBody.error)})`);

  console.log("\nSigned-URL refresh");
  r = await fetch(`${BASE}/api/posts/refresh-files`, {
    method: "POST", headers: { ...auth(A), "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [withFile.id] }),
  });
  const refreshed = await r.json().catch(() => ({}));
  check(r.status === 200, `POST refresh-files -> 200 (got ${r.status})`);
  check((refreshed.files || []).some(f => f.filename === file.filename && /token=/.test(f.url || "")),
    "refresh-files mints a fresh signed URL for the attachment");
  r = await fetch(`${BASE}/api/posts/refresh-files`, {
    method: "POST", headers: { ...auth(A), "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [withFile.id] }),
  });
  const rf = (await r.json()).files || [];
  if (rf.length) {
    const fr2 = await fetch(rf[0].url);
    check(fr2.status === 200, `refreshed signed URL downloads -> 200 (got ${fr2.status})`);
  }
  r = await fetch(`${BASE}/api/posts/refresh-files`, { method: "POST", headers: auth(A) });
  check(r.status === 401, `refresh-files unauthenticated -> 401 (got ${r.status})`);

  console.log("\nFeed paging");
  const page = await (await fetch(`${BASE}/api/posts?limit=2`, { headers: auth(B) })).json();
  check(Array.isArray(page) && page.length <= 2, `limit=2 caps the page (got ${Array.isArray(page) ? page.length : "non-array"})`);
  const tsAsc = Array.isArray(page) && page.every((p, i, a) => i === 0 || a[i - 1].timestamp <= p.timestamp);
  check(tsAsc, "a page comes back oldest-first for the bottom-anchored feed");
  if (Array.isArray(page) && page.length === 2) {
    const older = await (await fetch(`${BASE}/api/posts?limit=2&before=${page[0].timestamp}`, { headers: auth(B) })).json();
    check(Array.isArray(older) && older.every(p => p.timestamp < page[0].timestamp),
      `before=<ts> returns strictly older posts (got ${JSON.stringify((older || []).map(p => p.timestamp))})`);
  }
  const newest = await (await fetch(`${BASE}/api/posts?limit=1`, { headers: auth(B) })).json();
  const all = await (await fetch(`${BASE}/api/posts?limit=200`, { headers: auth(B) })).json();
  check(!newest.length || !all.length || newest[0].timestamp === all[all.length - 1].timestamp,
    "the newest page returns the latest post, not the oldest");
  r = await fetch(`${BASE}/api/posts?limit=99999`, { headers: auth(B) });
  check(r.status === 200, "an oversized limit is clamped, not rejected (got 200)");

  console.log("\nDelete authorisation");
  r = await fetch(`${BASE}/api/posts/${post.id}`, { method: "DELETE", headers: auth(B) });
  check(r.status === 403, `B deletes A's post -> 403 (got ${r.status})`);

  r = await fetch(`${BASE}/api/posts/${post.id}`, { method: "DELETE", headers: auth(A) });
  check(r.status === 204, `author deletes own post -> 204 (got ${r.status})`);

  const { data: deletedRow } = await admin.from("posts").select("deleted_at").eq("id", post.id).single();
  const firstDeletedAt = deletedRow && deletedRow.deleted_at;

  r = await fetch(`${BASE}/api/posts/${post.id}`, { method: "DELETE", headers: auth(A) });
  check(r.status === 404, `re-deleting -> 404 (got ${r.status})`);

  const { data: afterRetry } = await admin.from("posts").select("deleted_at").eq("id", post.id).single();
  check(afterRetry && afterRetry.deleted_at === firstDeletedAt,
    "retry did not overwrite the original deleted_at timestamp");
  const { data: delEvents } = await admin.from("events").select("id")
    .eq("user_id", A.id).eq("event_type", "message_deleted");
  check((delEvents || []).length === 1,
    `retry did not log a duplicate message_deleted (found ${(delEvents || []).length})`);

  r = await fetch(`${BASE}/api/posts`, { headers: auth(B) });
  const after = await r.json();
  check(!after.some(p => p.id === post.id), "deleted post is gone from the feed");
  check(after.some(p => p.id === withFile.id), "the other post survived the delete");

  r = await fetch(`${BASE}/api/posts/${post.id}`, { method: "DELETE", headers: auth(B) });
  check(r.status === 403, `other user still gets 403 on a deleted post -> 403 (got ${r.status})`);

  console.log("\nEvents + rate limit");
  const { data: evs } = await admin.from("events").select("event_type").eq("user_id", A.id);
  check((evs || []).some(e => e.event_type === "message_sent"), "message_sent was logged");
  check((evs || []).some(e => e.event_type === "file_uploaded"), "file_uploaded was logged");

  // postLimiter keys on req.ip with a 60s window, and every request above
  // shares one key — so this burst must use its own loopback address or it
  // inherits a partly-consumed window and straddles a reset.
  const BURST = "http://[::1]:" + PORT;
  let limited = false, retryAfter = null, allowed = 0;
  try {
    for (let i = 0; i < 40; i++) {
      const rr = await fetch(`${BURST}/api/posts`, {
        method: "POST", headers: { ...auth(B), "Content-Type": "application/json" },
        body: JSON.stringify({ text: "spam " + i }),
      });
      if (rr.status === 429) { limited = true; retryAfter = rr.headers.get("retry-after"); break; }
      if (rr.status === 201) allowed++;
    }
  } catch (_) { limited = "ipv6-unavailable"; }
  check(limited === true, `postLimiter returns 429 within 40 rapid posts (got ${limited})`);
  check(allowed >= 30, `limiter allowed ~max posts before throttling (allowed ${allowed})`);
  check(retryAfter !== null && +retryAfter > 0 && +retryAfter <= 60,
    `429 carries a sane Retry-After (${retryAfter})`);

  console.log("\nCleanup");
  const removed = await cleanup();
  const { data: left } = await admin.from("posts").select("id").in("author_id", TESTERS);
  check((left || []).length === 0, "all test posts removed from the database");
  console.log(`  (removed ${removed} posts, ${TESTERS.length} test users)`);

  console.log(`\n${fail ? fail + " FAILED" : "all passed"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.log("\nharness error: " + e.message);
  // Never leave test data behind: a crash mid-run used to orphan posts, files
  // and events that the next run then had to work around.
  await cleanup().catch(() => {});
  for (const id of TESTERS) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log("cleaned up after crash\n");
  process.exit(1);
});
