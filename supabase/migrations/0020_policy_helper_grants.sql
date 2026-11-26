-- 0020 — Policy-helper functions must be executable by anon (found by executing qa001, v8).
--
-- RLS policies added in 0012/0014 call is_staff(), series_member_role(),
-- can_view_analytics() and can_edit_assets() inside their USING expressions. Those
-- helpers had EXECUTE revoked from anon (0012/0014), so ANY anon SELECT on series,
-- chapters, chapter_assets, analytics_events, reports or copyright_cases raised
-- "permission denied for function" instead of evaluating the policy — guest browsing
-- of the public catalogue would error in production, not just return no rows.
--
-- The helpers are SECURITY DEFINER, read-only, and keyed on auth.uid(); for anon
-- (auth.uid() is null) they return false/null, so granting EXECUTE to anon grants no
-- data access — RLS still decides every row. This matches the standard Supabase
-- pattern: functions used in policies must be executable by every role that can
-- query the table.

grant execute on function series_member_role(uuid), owner_publishing_active(uuid),
  can_edit_assets(uuid), can_upload_assets(uuid), can_unpublish_chapters(uuid),
  can_publish_chapters(uuid), can_view_analytics(uuid), is_moderator(), is_staff()
  to anon;
