-- Apply explicitly to the chosen Supabase project. The application never runs migrations.
begin;

do $$
declare table_name text;
begin
  foreach table_name in array array['assets','asset_tokens','analyses','drafts','publications','comments'] loop
    execute format('create table if not exists public.futvr_%I (
      id text primary key,
      owner_id uuid,
      revision integer not null default 0 check (revision >= 0),
      publication_id text,
      parent_id text,
      data jsonb not null,
      created_at timestamptz not null default now(),
      check (data ->> ''id'' = id)
    )', table_name);
    execute format('create index if not exists %I on public.futvr_%I (owner_id)', 'futvr_' || table_name || '_owner', table_name);
    execute format('alter table public.futvr_%I enable row level security', table_name);
    -- All application reads/writes go through the owner-checking FastAPI service.
    -- Anon/authenticated direct access is intentionally denied, including publications.
    execute format('revoke all on public.futvr_%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.futvr_%I to service_role', table_name);
  end loop;
end $$;

create index if not exists futvr_comments_publication on public.futvr_comments(publication_id, created_at);

create or replace function public.futvr_reserve_analysis(
  record jsonb, owner_limit integer, global_limit integer, timeout_seconds integer
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  active_global integer;
  active_owner integer;
  target_owner uuid := (record ->> 'owner_id')::uuid;
begin
  if owner_limit < 1 or global_limit < 1 or timeout_seconds < 1 then
    raise exception 'invalid_queue_configuration';
  end if;
  perform pg_advisory_xact_lock(hashtext('futvr-analysis-admission'));
  select count(*), count(*) filter (where owner_id = target_owner)
    into active_global, active_owner
    from public.futvr_analyses
    where data ->> 'status' in ('queued', 'processing')
      and (data ->> 'created_ts')::double precision > extract(epoch from now()) - timeout_seconds;
  if active_global >= global_limit or active_owner >= owner_limit then
    raise exception 'queue_full';
  end if;
  insert into public.futvr_analyses(id, owner_id, revision, data)
    values(record ->> 'id', target_owner, coalesce((record ->> 'revision')::integer, 0), record -> 'data');
end $$;

create or replace function public.futvr_claim_guest(guest_id uuid, user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare table_name text;
begin
  if guest_id = user_id then return; end if;
  foreach table_name in array array['assets','asset_tokens','analyses','drafts'] loop
    execute format('update public.futvr_%I set owner_id = $2,
      data = jsonb_set(data, ''{owner_id}'', to_jsonb($2::text)) where owner_id = $1', table_name)
      using guest_id, user_id;
  end loop;
end $$;

revoke all on function public.futvr_reserve_analysis(jsonb, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.futvr_reserve_analysis(jsonb, integer, integer, integer) to service_role;
revoke all on function public.futvr_claim_guest(uuid, uuid) from public, anon, authenticated;
grant execute on function public.futvr_claim_guest(uuid, uuid) to service_role;

-- Original images are private. No storage.objects read policy is added.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('futvr-private', 'futvr-private', false, 104857600, array['image/png'])
on conflict (id) do update set public=false;

commit;
