-- 0006: covers/banners are set only by the trusted Worker after byte validation (SEC-006).
-- Creators may clear a cover (null) but never point it at an arbitrary key or URL.
create or replace function series_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if tg_op = 'INSERT' then
      new.view_count := 0; new.rating_avg := 0; new.rating_count := 0; new.rating_rank := 0; new.removed_by_moderation := false;
      new.cover_url := null; new.banner_url := null;
    else
      new.view_count := old.view_count; new.rating_avg := old.rating_avg; new.rating_count := old.rating_count;
      new.rating_rank := old.rating_rank; new.removed_by_moderation := old.removed_by_moderation;
      if old.removed_by_moderation then new.visibility := old.visibility; end if;
      if new.cover_url is not null and new.cover_url is distinct from old.cover_url then
        raise exception 'cover_url is set by the media processor' using errcode = '42501'; end if;
      if new.banner_url is not null and new.banner_url is distinct from old.banner_url then
        raise exception 'banner_url is set by the media processor' using errcode = '42501'; end if;
    end if;
  end if;
  return new;
end $$;
