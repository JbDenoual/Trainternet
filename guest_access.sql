-- À exécuter une fois dans Supabase : Dashboard > SQL Editor > New query.
--
-- Accès en lecture seule pour les invités (non connectés). Les tables restent
-- protégées par RLS : les invités passent uniquement par ces fonctions, qui
-- n'exposent que des données agrégées ou anonymisées — jamais d'identifiant
-- d'utilisateur ni de date réelle.

-- Carte générale : tous les pings, agrégés par case géographique
-- (0.002° ≈ 200 m). La taille minimale est bornée pour ne jamais pouvoir
-- redescendre au niveau d'un point GPS individuel.
create or replace function public.coverage_cells(
  p_cell_deg double precision default 0.002,
  p_slow_ms integer default 3000
)
returns table (
  lat double precision,
  lng double precision,
  ping_count integer,
  success_count integer,
  slow_count integer,
  avg_ok_latency_ms integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (floor(coalesce(p.end_lat, p.start_lat) / c.d) + 0.5) * c.d,
    (floor(coalesce(p.end_lng, p.start_lng) / c.d) + 0.5) * c.d,
    count(*)::int,
    (count(*) filter (where p.success))::int,
    (count(*) filter (where p.elapsed_ms > p_slow_ms))::int,
    coalesce(avg(p.elapsed_ms) filter (where p.success), 0)::int
  from public.pings p
  cross join (select greatest(p_cell_deg, 0.001) as d) c
  where coalesce(p.end_lat, p.start_lat) is not null
    and coalesce(p.end_lng, p.start_lng) is not null
  group by 1, 2
  order by 1, 2
$$;

-- Itinéraires connus : les trajets nommés (au moins 10 pings). Seuls le nom,
-- le nombre de pings et la durée sont exposés.
create or replace function public.public_routes()
returns table (
  id uuid,
  name text,
  ping_count integer,
  duration_min integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    t.name,
    count(p.id)::int,
    (extract(epoch from (max(p.sent_at) - min(p.sent_at))) / 60)::int
  from public.trips t
  join public.pings p on p.trip_id = t.id
  where coalesce(trim(t.name), '') <> ''
  group by t.id, t.name
  having count(p.id) >= 10
  order by t.name, min(p.sent_at)
$$;

-- Pings d'un itinéraire connu, avec un temps relatif au départ (en ms) au
-- lieu de l'horodatage réel : suffisant pour la prévision, qui n'utilise que
-- les écarts entre pings.
create or replace function public.public_route_pings(p_trip_id uuid)
returns table (
  offset_ms bigint,
  lat double precision,
  lng double precision,
  elapsed_ms integer,
  success boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (extract(epoch from (p.sent_at - min(p.sent_at) over ())) * 1000)::bigint,
    coalesce(p.end_lat, p.start_lat),
    coalesce(p.end_lng, p.start_lng),
    p.elapsed_ms,
    p.success
  from public.pings p
  join public.trips t on t.id = p.trip_id
  where p.trip_id = p_trip_id
    and coalesce(trim(t.name), '') <> ''
  order by p.sent_at
$$;

revoke execute on function public.coverage_cells(double precision, integer) from public;
revoke execute on function public.public_routes() from public;
revoke execute on function public.public_route_pings(uuid) from public;

grant execute on function public.coverage_cells(double precision, integer) to anon, authenticated;
grant execute on function public.public_routes() to anon, authenticated;
grant execute on function public.public_route_pings(uuid) to anon, authenticated;
