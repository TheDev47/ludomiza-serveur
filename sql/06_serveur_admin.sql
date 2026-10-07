-- Régie : un administrateur peut demander au serveur de jeu qui regarde
-- chaque partie (serveur 0.9.0). Le serveur vérifie le statut d'admin une fois
-- (gardé 5 min en mémoire) ; rien n'est écrit en base.
create or replace function public._serveur_est_admin(p_uid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $f$
  select coalesce((select is_admin from public.profiles where id = p_uid), false);
$f$;
revoke all on function public._serveur_est_admin(uuid) from public, anon, authenticated;
grant execute on function public._serveur_est_admin(uuid) to serveur_jeu;
