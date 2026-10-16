-- 0.19.0 : avant d'ouvrir une table de tournoi en spectateur, le serveur demande à la base
-- si cet utilisateur peut la regarder (tournoi LudoMiza : tout le monde ; tournoi privé :
-- seulement avec le code, en y jouant ou en l'organisant). Créée par la migration
-- 20261016060000_tournois_pause_spectateurs du dépôt ludo-app ; rappelée ici.
create or replace function public._serveur_peut_regarder(p_game uuid, p_uid uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select g.tournoi_id is null or public._tournoi_peut_regarder(g.tournoi_id, p_uid)
                     from games g where g.id = p_game), false);
$$;
revoke execute on function public._serveur_peut_regarder(uuid, uuid) from public, anon, authenticated;
grant execute on function public._serveur_peut_regarder(uuid, uuid) to serveur_jeu;
