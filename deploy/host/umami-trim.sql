-- Drops Umami's oldest analytics rows so anonymous posts to /stats/api/send cannot fill the
-- disk (umami-trim.sh). Each table keeps rows from the last :days days, at most :keep of them
-- (session replays, which hold whole recordings, :replays). Umami links rows only in its own
-- code, so trimming one table leaves rows in another without their partner; its reports skip
-- those. Tables this Umami version lacks are skipped.
SELECT set_config('trim.days', :'days', false), set_config('trim.keep', :'keep', false),
  set_config('trim.replays', :'replays', false) \g /dev/null
DO $$
DECLARE
  t text;
  keep bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['website_event', 'event_data', 'session', 'session_data',
    'session_link', 'revenue', 'heatmap_event', 'session_replay'] LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    keep := CASE t WHEN 'session_replay' THEN current_setting('trim.replays')::bigint
      ELSE current_setting('trim.keep')::bigint END;
    EXECUTE format('DELETE FROM %I WHERE created_at < now() - make_interval(days => %s)',
      t, current_setting('trim.days')::int);
    EXECUTE format('DELETE FROM %I WHERE ctid IN (SELECT ctid FROM %I
      ORDER BY created_at DESC NULLS LAST OFFSET %s)', t, t, keep);
  END LOOP;
END $$;
