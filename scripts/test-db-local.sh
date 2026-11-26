#!/usr/bin/env bash
# Runs every migration + SQL suite against a PLAIN local PostgreSQL (no Docker/Supabase).
# The Supabase environment is emulated by scripts/supabase-stub.sql (auth schema,
# auth.uid()/auth.role() from the request.jwt.claims setting, anon/authenticated/
# service_role roles, and Supabase-style default privileges). RLS, grants and RPC
# logic execute for real; this does NOT replace a final run on real Supabase
# (scripts/test-db.sh) before launch.
# Usage: DB_NAME=m2mtest ./scripts/test-db-local.sh   (requires a running local PG + psql as a superuser)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DB_NAME:-m2mtest}"
psql -d postgres -qc "drop database if exists $DB" -qc "create database $DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f scripts/supabase-stub.sql
for f in supabase/migrations/*.sql; do echo "== migration $f"; psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"; done
for f in supabase/tests/*.sql; do echo "== suite $f"; psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"; echo "PASS $f"; done
echo "ALL MIGRATIONS + SQL SUITES PASSED (plain-PostgreSQL harness)"
