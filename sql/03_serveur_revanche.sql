-- ============================================================================
-- Serveur de jeu : l'état d'une partie indique aussi sa REVANCHE en cours
-- (partie créée avec rematch_of = cette partie, en attente ou lancée), avec
-- les joueurs déjà assis. Les téléphones restés sur l'écran de fin la voient
-- ainsi arriver aussitôt, sans attendre les notifications de Supabase.
-- Même signature qu'avant : un serveur encore dans l'ancienne version marche.
-- ============================================================================
create or replace function public._serveur_etat(p_ids uuid[], p_actives boolean default false)
returns jsonb
language sql
volatile
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'game', to_jsonb(g),
           'seats', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'player_id', gp.player_id, 'color', gp.color, 'play_order', gp.play_order,
                       'pawns', gp.pawns, 'missed_turns', gp.missed_turns,
                       'moved_at', gp.moved_at, 'rang', gp.rang)
                     order by gp.play_order)
                from public.game_players gp where gp.game_id = g.id), '[]'::jsonb),
           'revanche', (
              select jsonb_build_object(
                       'id', r.id, 'status', r.status, 'host_id', r.host_id,
                       'game_players', coalesce((select jsonb_agg(jsonb_build_object('player_id', rp.player_id) order by rp.play_order)
                                                   from public.game_players rp where rp.game_id = r.id), '[]'::jsonb))
                from public.games r
               where g.status = 'finished' and r.rematch_of = g.id and r.status in ('waiting', 'playing')
               order by r.created_at desc limit 1),
           'maintenant', clock_timestamp())
         order by g.id), '[]'::jsonb)
    from public.games g
   where (p_actives and g.status = 'playing')
      or g.id = any(coalesce(p_ids, '{}'::uuid[]));
$function$;

revoke all on function public._serveur_etat(uuid[], boolean) from public, anon, authenticated;
grant execute on function public._serveur_etat(uuid[], boolean) to serveur_jeu;
