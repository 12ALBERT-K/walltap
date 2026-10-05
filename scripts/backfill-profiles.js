// One-off backfill: make sure every auth user has a profiles row.
//
//   npm run backfill-profiles
//
// Users created before the handle_new_user() trigger existed have no profile,
// so they'd be invisible to the admin dashboard and mis-flagged by admin checks.
// Safe to re-run: only missing rows are created, existing ones are untouched.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const PER_PAGE = 200;

// PostgREST caps a response at 1000 rows and silently truncates beyond it, so a
// single .select("id") used to make `present` incomplete on a busy project: any
// admin whose id fell outside the window looked "missing" and got overwritten
// with is_admin=false. Read the ids in explicit pages.
async function listProfileIds(supabase) {
  const ids = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .order("id")
      .range(from, to);
    if (error) throw error;
    if (!data || !data.length) break;
    ids.push(...data.map(r => r.id));
    if (data.length < pageSize) break;
  }
  return ids;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const present = new Set(await listProfileIds(supabase));

  const users = [];
  let page = 1;
  let lastPage = 1;
  do {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw error;
    if (!data || !data.users || !data.users.length) break;
    users.push(...data.users);
    lastPage = data.lastPage || page;
    page++;
  } while (page <= lastPage);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const u of users) {
    if (present.has(u.id)) { skipped++; continue; }

    const md = u.user_metadata || {};
    const username = String(
      (md.display_name || "").trim() ||
      (u.email || "").split("@")[0] ||
      "user"
    ).slice(0, 40) || "user";

    // ignoreDuplicates, not a plain upsert: the row is only ever created when it
    // is genuinely absent, so a stale/partial `present` set can never overwrite an
    // existing profile's is_admin.
    const { error } = await supabase.from("profiles").upsert(
      { id: u.id, username, is_admin: false },
      { onConflict: "id", ignoreDuplicates: true }
    );
    if (error) {
      console.warn(`  skipped ${u.email || u.id}: ${error.message}`);
      failed++;
      continue;
    }
    created++;
  }

  console.log(`Backfill complete.`);
  console.log(`  auth users total   : ${users.length}`);
  console.log(`  profiles already   : ${skipped}`);
  console.log(`  profiles created   : ${created}`);
  if (failed) console.log(`  failed to create  : ${failed} (see warnings above)`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});