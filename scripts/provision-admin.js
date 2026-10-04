// One-off provisioning script: create the Walltap admin account.
//
//   npm run provision-admin
//   npm run provision-admin -- --promote   (see below)
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (see .env.example),
// prompts for the email and password at runtime — the password is NEVER
// written to disk or printed.
require("dotenv").config();
const readline = require("readline");
const { createClient } = require("@supabase/supabase-js");

// Preferred username for the admin account. NOT load-bearing: the admin
// dashboard authorises on profiles.is_admin, not on the username (see
// netlify/functions/_shared/supabase.js). This is only the display name, so a
// collision falls back to a free variant instead of aborting the run.
const ADMIN_USERNAME = "admin";

// Promotion is opt-in. An account that already exists is a real user account,
// and a regular user must never silently double as the admin account (see
// ROADMAP Phase 2 §2.2). --promote is the explicit acknowledgement of that.
const ALLOW_PROMOTE = process.argv.includes("--promote");

function promptHidden(query) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    const handler = (ch) => {
      ch = String(ch);
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.removeListener("data", handler);
        stdout.write("\n");
        return resolve(input);
      }
      if (ch === "\u0003") { // Ctrl+C
        stdout.write("\nAborted.\n");
        process.exit(1);
      }
      if (ch === "\u0008" || ch === "\u007f") {
        input = input.slice(0, -1);
        stdout.write("\b \b");
      } else {
        input += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", handler);
    stdin.resume();
  });
}

// profiles.username is UNIQUE, so a fixed name can only ever be claimed once.
// Ask the database for the first free variant rather than assuming "admin" is
// available — the signup trigger already does exactly this for real users.
function usernameCandidates(base) {
  return [base, `${base}2`, `${base}3`, `${base}4`];
}

async function freeUsername(db, base) {
  const candidates = usernameCandidates(base);
  const { data, error } = await db.from("profiles").select("username").in("username", candidates);
  if (error) throw error;
  const taken = new Set((data || []).map((r) => r.username));
  const free = candidates.find((c) => !taken.has(c));
  if (!free) throw new Error(`Could not find a free username based on "${base}".`);
  return free;
}

async function findUserByEmail(supabase, email) {
  // listUsers() is paginated; walk the pages so an admin beyond the first page
  // is still found rather than reported as "not registered".
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data && data.users ? data.users : [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 1000) return null;
  }
  return null;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const email = (await ask("Admin email: ")).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    console.error("That doesn't look like a valid email address.");
    process.exit(1);
  }
  const password = await promptHidden("Admin password (will not be echoed): ");
  if (password.length < 8) {
    console.error("Password must be at least 8 characters (Supabase default minimum).");
    process.exit(1);
  }
  rl.close();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  let userId;
  let createdHere = false;

  const existing = await findUserByEmail(supabase, email);
  if (existing) {
    if (!ALLOW_PROMOTE) {
      // Deliberately refuse to promote an existing account by default: a regular
      // user must never double as the admin account (see ROADMAP Phase 2 §2.2).
      console.error(
        `\n${email} already exists.\n` +
        `Refusing to upgrade it to admin - a regular user account must not double as\n` +
        `the admin account. Use a dedicated admin email (e.g. admin@yoursite.com).\n\n` +
        `If this account was created by an earlier failed run of this script and is\n` +
        `therefore not a real user account, re-run with:\n` +
        `  npm run provision-admin -- --promote\n`
      );
      process.exit(1);
    }
    userId = existing.id;
    console.log(`Using existing account ${email}.`);
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: ADMIN_USERNAME }
    });
    if (createErr) throw createErr;
    userId = created.user.id;
    createdHere = true;
    console.log(`Created user ${email}.`);
  }

  // The signup trigger already inserted a profile row for a brand-new user, so
  // only pick a username when there is nothing to keep. Reusing the trigger's
  // row is what keeps this script from tripping over its own UNIQUE username.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("id, username")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) throw profileErr;

  const username = profile ? profile.username : await freeUsername(supabase, ADMIN_USERNAME);

  const { error: upsertErr } = await supabase
    .from("profiles")
    .upsert({ id: userId, username, is_admin: true }, { onConflict: "id" });
  if (upsertErr) {
    // Don't leave a confirmed account behind that can sign in but owns nothing.
    // That orphan is what makes a failed run unrecoverable on the next attempt.
    if (createdHere) {
      await supabase.auth.admin.deleteUser(userId).catch(() => {});
      console.error(`Rolled back the user created for ${email} after the grant failed.`);
    }
    throw upsertErr;
  }

  console.log(`Done. ${email} is now an admin (profiles.is_admin = true, username "${username}").`);
  console.log("Sign into the app, then open the admin dashboard.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});