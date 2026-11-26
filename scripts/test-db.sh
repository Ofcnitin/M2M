#!/usr/bin/env bash
# Applies every migration to a throwaway local database and runs the SQL test suites. Needs the Supabase CLI and Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f supabase/config.toml ] || supabase init
supabase start
supabase db reset
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
for f in supabase/tests/0005_lockdown.sql supabase/tests/0012_moderation.sql supabase/tests/qa001_rls_matrix.sql supabase/tests/0015_sec007.sql supabase/tests/0016_age_assurance.sql supabase/tests/0017_media_privacy.sql; do
  echo "== $f"; psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
