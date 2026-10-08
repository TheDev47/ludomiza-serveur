-- ============================================================================
-- Présence notée par le serveur de jeu (0.10.0)
--
-- Le serveur sait quels joueurs ont l'appli ouverte (ligne directe) et à
-- l'écran (message « visible »). Toutes les 30 s, il note leur présence en UNE
-- requête, au lieu d'un appel noter_vu / salle_present par téléphone.
-- ============================================================================
create or replace function public._serveur_presence(p_ids uuid[])
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare nb int := 0;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  -- « Vu il y a… » : au plus une écriture par minute et par joueur (comme noter_vu)
  insert into public.presence_vue (user_id, vu_le)
  select u, now() from unnest(p_ids) u
   where exists (select 1 from public.profiles p where p.id = u)
  on conflict (user_id) do update set vu_le = now()
   where public.presence_vue.vu_le < now() - interval '60 seconds';
  -- Salle d'attente : le joueur est là (comme salle_present)
  update public.game_players gp set salle_vu_le = now()
    from public.games g
   where g.id = gp.game_id and g.status = 'waiting' and gp.player_id = any(p_ids);
  get diagnostics nb = row_count;
  return nb;
end $function$;

revoke all on function public._serveur_presence(uuid[]) from public;
grant execute on function public._serveur_presence(uuid[]) to serveur_jeu;
