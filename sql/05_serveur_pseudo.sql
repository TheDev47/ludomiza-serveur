-- Pseudo d'un joueur, pour signer les réactions des spectateurs (serveur 0.8.0).
-- Lu une fois par connexion de spectateur (gardé en mémoire par le serveur) :
-- aucun appel à chaque réaction.
create or replace function public._serveur_pseudo(p_uid uuid)
 returns text language sql stable security definer set search_path to 'public'
as $f$
  select coalesce(nullif(btrim(p.pseudo), ''), 'Spectateur') from public.profiles p where p.id = p_uid;
$f$;
revoke all on function public._serveur_pseudo(uuid) from public, anon, authenticated;
grant execute on function public._serveur_pseudo(uuid) to serveur_jeu;
