// One-off provisioning script: create the Walltap admin account.
//
//   npm run provision-admin
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (see .env.example),
// prompts for the email and password at runtime — the password is NEVER
// written to disk or printed.
require("dotenv").config();
const readline = require("readline");
const { createClient } = require("@supabase/supabase-js");

const ADMIN_USERNAME = "admin";

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
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: ADMIN_USERNAME }
  });
  if (createErr) {
    if (/already registered|already exists/i.test(createErr.message)) {
      console.log(`User ${email} already exists — upgrading it to admin.`);
      const { data: byEmail, error: findErr } = await supabase.auth.admin.listUsers();
      if (findErr) throw findErr;
      const existing = byEmail.users.find((u) => u.email === email);
      if (!existing) throw new Error("Could not locate the existing user.");
      userId = existing.id;
    } else {
      throw createErr;
    }
  } else {
    userId = created.user.id;
    console.log(`Created user ${email}.`);
  }

  const { error: upsertErr } = await supabase
    .from("profiles")
    .upsert({ id: userId, username: ADMIN_USERNAME, is_admin: true }, { onConflict: "id" });
  if (upsertErr) throw upsertErr;

  console.log("Done. User is now an admin (profiles.is_admin = true).");
  console.log("Sign into the app, then open the admin dashboard.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});