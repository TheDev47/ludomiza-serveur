-- ============================================================================
-- Spectateurs notés par le serveur de jeu (0.16.0)
--
-- Le serveur sait combien de personnes regardent chaque partie. Il envoie
-- { idPartie: nombre } quand ça change (et au moins toutes les 2 min) ;
-- la liste « En cours » de l'accueil (parties_en_cours) affiche « 👁 N ».
-- Table à part : rien n'est écrit dans games (pas de signaux ni de temps réel).
-- ============================================================================
create table if not exists public.parties_spectateurs (
  game_id uuid primary key references public.games(id) on delete cascade,
  n integer not null,
  maj_le timestamptz not null default now()
);
alter table public.parties_spectateurs enable row level security;   -- lue seulement par parties_en_cours

create or replace function public._serveur_spectateurs(p jsonb)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  delete from public.parties_spectateurs s
   where not (coalesce(p, '{}'::jsonb) ? s.game_id::text);
  insert into public.parties_spectateurs (game_id, n, maj_le)
  select k::uuid, greatest(0, v::text::int), now()
    from jsonb_each(coalesce(p, '{}'::jsonb)) as e(k, v)
   where exists (select 1 from public.games g where g.id = k::uuid)
  on conflict (game_id) do update set n = excluded.n, maj_le = now();
end $function$;

revoke all on function public._serveur_spectateurs(jsonb) from public, anon, authenticated;
grant execute on function public._serveur_spectateurs(jsonb) to serveur_jeu;
