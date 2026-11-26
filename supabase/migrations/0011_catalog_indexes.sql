-- 0011: indexes for the Discover sorts and common reader queries (RD-002). series_listing_idx already covers "updated".
-- Verify with EXPLAIN ANALYZE on realistic data before relying on them; drop any the planner does not use.
create index if not exists series_new_idx on series (visibility, created_at desc);
create index if not exists series_popular_idx on series (visibility, view_count desc);
create index if not exists series_title_idx on series (visibility, title);
create index if not exists chapters_public_idx on chapters (series_id, chapter_number) where publication_status = 'published';
create index if not exists chapter_assets_order_idx on chapter_assets (chapter_id, display_order) where processing_status = 'ready';
create index if not exists follows_creator_idx on follows (creator_id);
create index if not exists library_series_idx on library (series_id, reading_status);
