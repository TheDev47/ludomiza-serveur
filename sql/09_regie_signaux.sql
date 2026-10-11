-- (0.14.0) Signaux de la régie : la régie est prévenue à l'instant (par le serveur de jeu)
-- quand une partie est créée, lancée ou finie, quand un paiement arrive ou change,
-- quand un compte est créé ou qu'un joueur écrit au support. Elle relit alors ses chiffres
-- au lieu de les redemander toutes les 30 secondes.
-- Sujet « regie » : le serveur ne l'envoie qu'aux écrans d'administration (admin_suivre),
-- jamais aux téléphones des joueurs. Aucun signal à chaque coup joué.

create or replace function public._sig_regie() returns trigger
language plpgsql security definer set search_path to 'public' as $f$
begin
  perform public._signal(null, 'regie', tg_argv[0]);
  return null;
exception when others then return null;
end $f$;
revoke all on function public._sig_regie() from public, anon, authenticated;

create trigger sig_regie_parties after insert or delete on public.games
  for each row execute function public._sig_regie('parties');
create trigger sig_regie_parties_statut after update of status on public.games
  for each row when (old.status is distinct from new.status) execute function public._sig_regie('parties');
create trigger sig_regie_paiements after insert on public.payment_requests
  for each row execute function public._sig_regie('paiements');
create trigger sig_regie_paiements_statut after update of status on public.payment_requests
  for each row when (old.status is distinct from new.status) execute function public._sig_regie('paiements');
create trigger sig_regie_comptes after insert on public.profiles
  for each row execute function public._sig_regie('joueurs');
create trigger sig_regie_support after insert on public.support_chat
  for each row when (new.sender = 'user') execute function public._sig_regie('support');
