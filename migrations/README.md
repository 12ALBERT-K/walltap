# Schema migrations

Walltap keeps its schema in one place: **`SCHEMA_SQL` in `server.js`**. Every
statement is idempotent (guarded `IF NOT EXISTS`, `DROP POLICY` + `CREATE
POLICY`, `DO $$` blocks checking `pg_constraint`/`pg_policies`), and the server
applies it on every boot when `DATABASE_URL` is set.

There is intentionally no separate migration runner — the running app and the
admin dashboard share the same Supabase Postgres, and this single file keeps
them in sync.

## Workflow for a schema change

1. Edit `SCHEMA_SQL` in `server.js` and keep it idempotent:
   - New columns: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
   - New tables/views/triggers: `CREATE ... IF NOT EXISTS` /
     `CREATE OR REPLACE`.
   - New constraints or policies: guard with an existence check inside
     `DO $$ BEGIN ... END $$;`.
2. Boot the server once locally to confirm `Schema → ensured`.
3. In production, apply the change through the Supabase SQL editor (paste the
   new `SCHEMA_SQL`), or:
   ```bash
   supabase db push    # if you mirror SCHEMA_SQL into supabase/migrations
   ```
4. Old data that would violate a new `CHECK` constraint gets normalized inside
   the same `DO $$` block *before* the constraint is added.

## Production safety notes

- `SCHEMA_SQL` runs as one transaction — if any statement fails, nothing is
  applied (the boot log reports `Startup check failed`).
- Storage (bucket privacy, signed URLs) and Realtime RLS policies are also
  enforced on every boot in `server.js`.
- The admin repo (`whatapp-admin/`) contains no schema — it only reads this
  same project.