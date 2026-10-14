-- ============================================================================
-- Listes de l'accueil lues par le serveur de jeu (0.18.0)
--
-- « Ouvertes » (parties publiques en attente), parties privées en attente
-- (affichées avec un cadenas, jamais leur code) et « En cours ». Le serveur les
-- lit une fois et les envoie à tous les téléphones qui regardent l'accueil, au
-- lieu que chaque téléphone appelle Supabase toutes les 8 à 30 s (chaque appel
-- compte dans les journaux et les données sortantes de Supabase).
-- Mêmes champs que ce que l'appli lisait elle-même. Le téléphone retire ses
-- propres parties (host_id).
-- ============================================================================
create or replace function public._serveur_accueil()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
begin
  return jsonb_build_object(
    'ouvertes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'code', g.code, 'mise', g.mise, 'max_players', g.max_players, 'mode', g.mode,
               'host_id', g.host_id, 'status', g.status, 'prive', false,
               'host', jsonb_build_object('pseudo', h.pseudo, 'avatar_color', h.avatar_color),
               'game_players', jsonb_build_array(jsonb_build_object('count',
                  (select count(*) from public.game_players gp where gp.game_id = g.id))))
             order by g.created_at desc)
        from public.games g left join public.profiles h on h.id = g.host_id
       where g.status = 'waiting' and not coalesce(g.prive, false)), '[]'::jsonb),
    'privees', coalesce((
      select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object('id', g.id, 'mode', g.mode, 'max_players', g.max_players, 'created_at', g.created_at,
                 'host_id', g.host_id,
                 'host', jsonb_build_object('pseudo', h.pseudo, 'avatar_color', h.avatar_color),
                 'nb', (select count(*) from public.game_players gp where gp.game_id = g.id)) x
          from public.games g join public.profiles h on h.id = g.host_id
         where g.status = 'waiting' and coalesce(g.prive, false) and g.created_at > now() - interval '6 hours'
         order by g.created_at desc limit 9) s), '[]'::jsonb),
    'en_cours', coalesce((
      select jsonb_agg(x order by x->>'debut' desc) from (
        select jsonb_build_object(
                 'id', g.id, 'prive', coalesce(g.prive, false), 'mode', g.mode,
                 'mise', case when coalesce(g.prive, false) then null else g.mise end,
                 'debut', coalesce(g.started_at, g.created_at),
                 'nb', (select count(*) from public.game_players gp where gp.game_id = g.id),
                 'joueurs', case when coalesce(g.prive, false) then '[]'::jsonb else
                   (select coalesce(jsonb_agg(jsonb_build_object('pseudo', p.pseudo, 'couleur', p.avatar_color) order by gp.play_order), '[]'::jsonb)
                      from public.game_players gp join public.profiles p on p.id = gp.player_id where gp.game_id = g.id) end,
                 'spectateurs', coalesce((select s.n from public.parties_spectateurs s where s.game_id = g.id and s.maj_le > now() - interval '3 minutes'), 0)) x
          from public.games g
         where g.status = 'playing' and g.tournoi_id is null
         order by coalesce(g.started_at, g.created_at) desc
         limit 20) s), '[]'::jsonb));
end $function$;

revoke all on function public._serveur_accueil() from public, anon, authenticated;
grant execute on function public._serveur_accueil() to serveur_jeu;
