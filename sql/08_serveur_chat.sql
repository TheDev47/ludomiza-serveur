-- Chat libre des parties (serveur 0.11.0). Les messages ne sont PAS enregistrés :
-- le serveur de jeu les vérifie et les relaie. La base ne sert qu'aux suspensions
-- (numéro de téléphone envoyé : chat coupé 24 h), qui restent rares.
create table if not exists public.chat_suspensions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  game_id uuid,
  jusqua timestamptz not null,
  motif text not null,
  message text,
  cree_le timestamptz not null default now(),
  levee_le timestamptz
);
create index if not exists chat_suspensions_user on public.chat_suspensions (user_id, jusqua desc);
alter table public.chat_suspensions enable row level security;
revoke all on public.chat_suspensions from anon, authenticated;

-- Fin de la suspension en cours (null si le joueur peut écrire)
create or replace function public._serveur_chat_etat(p_uid uuid)
 returns timestamptz language sql stable security definer set search_path to 'public'
as $f$
  select max(jusqua) from public.chat_suspensions
   where user_id = p_uid and levee_le is null and jusqua > now();
$f$;
revoke all on function public._serveur_chat_etat(uuid) from public, anon, authenticated;
grant execute on function public._serveur_chat_etat(uuid) to serveur_jeu;

-- Suspendre le chat 24 h (le message fautif est gardé pour la régie)
create or replace function public._serveur_chat_suspendre(p_uid uuid, p_partie uuid, p_message text, p_motif text)
 returns timestamptz language plpgsql security definer set search_path to 'public'
as $f$
declare v timestamptz := now() + interval '24 hours';
begin
  insert into public.chat_suspensions (user_id, game_id, jusqua, motif, message)
  values (p_uid, p_partie, v, left(coalesce(p_motif, 'numero'), 40), left(p_message, 300));
  return v;
end $f$;
revoke all on function public._serveur_chat_suspendre(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public._serveur_chat_suspendre(uuid, uuid, text, text) to serveur_jeu;
