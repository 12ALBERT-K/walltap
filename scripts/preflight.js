// Preflight check before deploying or handing over. Verifies configuration that
// has silently broken things before, and fails loudly rather than at runtime.
//
//   node scripts/preflight.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let failures = 0;
let warnings = 0;

const ok = (m) => console.log("  PASS  " + m);
const bad = (m) => { failures++; console.log("  FAIL  " + m); };
const warn = (m) => { warnings++; console.log("  WARN  " + m); };

console.log("\nEnvironment");
const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
for (const k of required) {
  if (!process.env[k]) bad(`${k} is not set`);
}
if (!process.env.DATABASE_URL) {
  warn("DATABASE_URL is not set — schema bootstrap will be skipped and existing tables assumed");
} else if (!/sslmode=/.test(process.env.DATABASE_URL)) {
  warn("DATABASE_URL has no sslmode= — the server will connect with rejectUnauthorized:false");
}

// The two ways this project has actually leaked.
console.log("\nKey hygiene");
const url = process.env.SUPABASE_URL || "";
const anon = process.env.SUPABASE_ANON_KEY || "";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (service && anon && service === anon) bad("SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are identical");
if (service) {
  // Supabase has two key formats and a JWT-only check silently no-ops on the
  // new one — which reads as "passed" while testing nothing.
  if (service.startsWith("sb_secret_")) {
    ok("service key is a new-format sb_secret_ key");
  } else if (service.startsWith("sb_publishable_")) {
    bad("SUPABASE_SERVICE_ROLE_KEY is a sb_publishable_ (public) key — it grants nothing and will fail every admin query");
  } else {
    const claims = service.split(".")[1];
    if (!claims) {
      bad("service key is neither sb_secret_* nor a decodable JWT — cannot verify its role");
    } else {
      try {
        const role = JSON.parse(Buffer.from(claims, "base64url").toString()).role;
        role === "service_role" ? ok("service key is a JWT with role=service_role")
                                : bad(`service key decodes to role=${role}, not service_role`);
      } catch (_) { bad("service key is not a decodable JWT"); }
    }
  }
}
if (anon) {
  if (anon.startsWith("sb_publishable_")) ok("anon key is a new-format sb_publishable_ key");
  else if (anon.startsWith("sb_secret_")) bad("SUPABASE_ANON_KEY is a secret key — it must never be the browser-facing key");
  else {
    const claims = anon.split(".")[1];
    if (claims) {
      try {
        const role = JSON.parse(Buffer.from(claims, "base64url").toString()).role;
        role === "anon" ? ok("anon key is a JWT with role=anon")
                        : bad(`anon key decodes to role=${role} — a privileged key is in the browser-facing slot`);
      } catch (_) { warn("anon key is not a decodable JWT"); }
    } else warn("anon key format not recognised");
  }
}
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url)) {
  warn(`SUPABASE_URL host is not the usual supabase.co/.in form: ${url}`);
}
if (/\.supabase\.in$/.test(url)) {
  warn("project is on *.supabase.in but server.js CSP only allows *.supabase.co — realtime/auth will be blocked");
}

console.log("\nLeak scan (tracked files only)");
const skip = new Set(["node_modules", ".git", ".netlify", "data", "uploads"]);
const suspects = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html|json|md|yaml|yml|toml)$/.test(e.name)) continue;
    let text;
    try { text = fs.readFileSync(p, "utf8"); } catch (_) { continue; }
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g)) {
      try {
        const role = JSON.parse(Buffer.from(m[0].split(".")[1], "base64url").toString()).role;
        if (role === "service_role") suspects.push(`${path.relative(ROOT, p)} (service_role JWT)`);
      } catch (_) {}
    }
  }
})(ROOT);
suspects.length ? suspects.forEach(s => bad("service_role JWT committed in " + s))
                : ok("no service_role JWT in any tracked source file");

console.log("\nConfig endpoint");
const srv = path.join(ROOT, "server.js");
const srvText = fs.readFileSync(srv, "utf8");
const cfg = srvText.match(/app\.get\("\/config\.js"[\s\S]*?\n\}\);/);
if (!cfg) bad("server.js has no /config.js route");
else if (/SERVICE_ROLE/.test(cfg[0])) bad("/config.js appears to expose the service role key");
else ok("/config.js exposes URL + anon key only");

console.log("\nEncoding");
for (const f of ["public/index.html", "public/app.js", "server.js"]) {
  const t = fs.readFileSync(path.join(ROOT, f), "utf8");
  const n = (t.match(/\uFFFD/g) || []).length;
  n ? bad(`${f} contains ${n} U+FFFD replacement character(s)`) : ok(`${f} is clean UTF-8`);
}

console.log("\nAdmin dashboard");
const adminDir = path.join(ROOT, "walltap-admin", "netlify", "functions");
if (!fs.existsSync(adminDir)) {
  warn("walltap-admin/ not present (separate repo) — skipping");
} else {
  const fns = fs.readdirSync(adminDir).filter(f => f.endsWith(".js") && !f.startsWith("_"));
  const expected = ["list-users.js", "list-all-messages.js", "analytics-summary.js"];
  const extra = fns.filter(f => !expected.includes(f));
  extra.length ? extra.forEach(f => bad(`unexpected deployable function: ${f} (Netlify WILL bundle it)`))
               : ok(`exactly the ${expected.length} expected functions`);
  const debug = fs.readdirSync(adminDir).filter(f => /^_.*\.js$/.test(f) && f !== "_shared");
  debug.length ? debug.forEach(f => bad(`debug-style function present: ${f} — the _ prefix does NOT exclude files`))
               : ok("no unauthenticated debug functions");
}

console.log(`\n${failures ? failures + " FAILURE(S)" : "all checks passed"}${warnings ? ", " + warnings + " warning(s)" : ""}\n`);
process.exit(failures ? 1 : 0);
