-- ============================================================================
-- Serveur de jeu : « ligne directe » de chaque joueur (signaux hors partie).
--
-- But : que l'appli n'ait plus besoin du temps réel de Supabase (limité à 200
-- connexions simultanées et 2 millions de messages par mois en formule
-- gratuite) quand le serveur de jeu est joignable.
--
-- Principe :
--   1. Des déclencheurs ajoutent une petite ligne dans evenements_serveur à
--      chaque événement utile : « tel joueur doit relire son solde », « le
--      salon des parties a changé », etc. AUCUNE donnée, juste un sujet.
--   2. Le serveur de jeu lit ce journal UNE fois par seconde, en une seule
--      requête pour tous les joueurs (_serveur_evenements), et prévient les
--      téléphones concernés.
--   3. L'appli relit la donnée par Supabase, comme avant.
--
-- Sûreté : un déclencheur de signal ne fait JAMAIS échouer l'opération qui
-- l'a déclenché (mise, gain, dépôt…) : toute erreur y est ignorée.
-- Le serveur de jeu ne lit que les sujets (pas les tables) : son rôle reste
-- limité aux fonctions _serveur_*.
--
-- Sujets (user_id null = pour tout le monde) :
--   notifications  (joueur)            notification ajoutée, lue, supprimée
--   amis           (joueur)            demande d'ami, acceptation, retrait
--   solde          (joueur)            mouvement dans le grand livre
--   paiements      (joueur)            dépôt / retrait créé ou traité
--   support        (joueur)            message du support
--   partie         (joueur, cle=id)    arrivée/départ/statut d'une partie où il est assis,
--                                      ou revanche d'une partie où il était assis
--   salon          (tous)              une partie en attente apparaît, change ou disparaît
--   tournoi        (tous, cle=id)      une table de tournoi s'ouvre ou se termine
-- ============================================================================

create table if not exists public.evenements_serveur (
  id       bigint generated always as identity primary key,
  user_id  uuid,
  sujet    text not null,
  cle      text,
  cree_le  timestamptz not null default clock_timestamp()
);
create index if not exists evenements_serveur_cree_le on public.evenements_serveur (cree_le);
alter table public.evenements_serveur enable row level security;   -- aucune politique : invisible aux joueurs
revoke all on public.evenements_serveur from anon, authenticated;

-- Ajout d'un signal. Ne lève jamais d'erreur.
create or replace function public._signal(p_user uuid, p_sujet text, p_cle text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.evenements_serveur (user_id, sujet, cle) values (p_user, p_sujet, p_cle);
exception when others then
  null;
end $function$;
revoke all on function public._signal(uuid, text, text) from public, anon, authenticated;

-- Joueurs assis à une partie (et à la partie dont elle est la revanche).
create or replace function public._signal_partie(p_game uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare g record; u uuid;
begin
  if p_game is null then return; end if;
  select id, host_id, rematch_of into g from public.games where id = p_game;
  for u in select player_id from public.game_players where game_id = p_game
           union select g.host_id where g.host_id is not null loop
    perform public._signal(u, 'partie', p_game::text);
  end loop;
  if g.rematch_of is not null then
    for u in select player_id from public.game_players where game_id = g.rematch_of loop
      perform public._signal(u, 'partie', g.rematch_of::text);
    end loop;
  end if;
exception when others then
  null;
end $function$;
revoke all on function public._signal_partie(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- déclencheurs ----

create or replace function public._sig_notifications() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._signal(coalesce(new.user_id, old.user_id), 'notifications');
  if tg_op = 'INSERT' and new.type in ('friend_request', 'friend_accepted') then
    perform public._signal(new.user_id, 'amis');
  end if;
  return null;
exception when others then return null;
end $function$;

create or replace function public._sig_solde() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._signal(new.player_id, 'solde');
  return null;
exception when others then return null;
end $function$;

create or replace function public._sig_paiements() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._signal(coalesce(new.user_id, old.user_id), 'paiements');
  return null;
exception when others then return null;
end $function$;

create or replace function public._sig_amis() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._signal(coalesce(new.requester_id, old.requester_id), 'amis');
  perform public._signal(coalesce(new.addressee_id, old.addressee_id), 'amis');
  return null;
exception when others then return null;
end $function$;

create or replace function public._sig_support() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._signal(coalesce(new.user_id, old.user_id), 'support');
  return null;
exception when others then return null;
end $function$;

-- Parties : seulement création, suppression et CHANGEMENT DE STATUT
-- (jamais à chaque coup : voir la condition when des déclencheurs).
create or replace function public._sig_games() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare g record;
begin
  g := coalesce(new, old);
  if (tg_op <> 'UPDATE' and g.status = 'waiting')
     or (tg_op = 'UPDATE' and (old.status = 'waiting' or new.status = 'waiting'
                               or old.prive is distinct from new.prive)) then
    perform public._signal(null, 'salon');
  end if;
  if g.tournoi_id is not null and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status is distinct from new.status)) then
    perform public._signal(null, 'tournoi', g.tournoi_id::text);
  end if;
  if tg_op = 'DELETE' then
    perform public._signal(old.host_id, 'partie', old.id::text);
  else
    perform public._signal_partie(g.id);
  end if;
  return null;
exception when others then return null;
end $function$;

create or replace function public._sig_sieges() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_game uuid := coalesce(new.game_id, old.game_id); v_statut text;
begin
  select status into v_statut from public.games where id = v_game;
  if v_statut = 'waiting' then perform public._signal(null, 'salon'); end if;
  perform public._signal_partie(v_game);
  if tg_op = 'DELETE' then perform public._signal(old.player_id, 'partie', v_game::text); end if;
  return null;
exception when others then return null;
end $function$;

drop trigger if exists sig_notifications on public.notifications;
create trigger sig_notifications after insert or update or delete on public.notifications
  for each row execute function public._sig_notifications();

drop trigger if exists sig_solde on public.transactions;
create trigger sig_solde after insert on public.transactions
  for each row execute function public._sig_solde();

drop trigger if exists sig_paiements on public.payment_requests;
create trigger sig_paiements after insert or update on public.payment_requests
  for each row execute function public._sig_paiements();

drop trigger if exists sig_amis on public.friendships;
create trigger sig_amis after insert or update or delete on public.friendships
  for each row execute function public._sig_amis();

drop trigger if exists sig_support on public.support_chat;
create trigger sig_support after insert or update on public.support_chat
  for each row execute function public._sig_support();

drop trigger if exists sig_games_ins_del on public.games;
create trigger sig_games_ins_del after insert or delete on public.games
  for each row execute function public._sig_games();
drop trigger if exists sig_games_statut on public.games;
create trigger sig_games_statut after update of status, prive on public.games
  for each row when (old.status is distinct from new.status or old.prive is distinct from new.prive)
  execute function public._sig_games();

drop trigger if exists sig_sieges on public.game_players;
create trigger sig_sieges after insert or delete on public.game_players
  for each row execute function public._sig_sieges();

-- ------------------------------------------------------ lecture par le serveur ----
-- p_apres null : renvoie seulement le dernier numéro (point de départ).
-- Sinon : les signaux depuis p_apres, en relisant aussi les 1000 numéros
-- précédents des 20 dernières secondes. Deux transactions simultanées peuvent
-- en effet valider leurs lignes dans le désordre : une ligne de numéro plus
-- petit peut apparaître APRÈS une plus grande. Le serveur ignore les numéros
-- déjà vus. Chaque élément : [id, user_id, sujet, cle].
create or replace function public._serveur_evenements(p_apres bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_dernier bigint; v_evts jsonb;
begin
  if p_apres is null then
    select coalesce(max(id), 0) into v_dernier from public.evenements_serveur;
    return jsonb_build_object('dernier', v_dernier, 'evts', '[]'::jsonb);
  end if;
  select coalesce(max(id), p_apres),
         coalesce(jsonb_agg(jsonb_build_array(id, user_id, sujet, cle) order by id), '[]'::jsonb)
    into v_dernier, v_evts
    from (select id, user_id, sujet, cle from public.evenements_serveur
           where id > p_apres - 1000
             and (id > p_apres or cree_le > clock_timestamp() - interval '20 seconds')
           order by id limit 5000) lot;
  return jsonb_build_object('dernier', greatest(v_dernier, p_apres), 'evts', v_evts);
end $function$;
revoke all on function public._serveur_evenements(bigint) from public, anon, authenticated;
grant execute on function public._serveur_evenements(bigint) to serveur_jeu;

-- Ménage : les signaux ne servent que quelques secondes.
create or replace function public._purger_evenements_serveur()
returns void language sql security definer set search_path to 'public' as $function$
  delete from public.evenements_serveur where cree_le < now() - interval '10 minutes';
$function$;
revoke all on function public._purger_evenements_serveur() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ludomiza-purge-signaux', '*/10 * * * *', 'select public._purger_evenements_serveur()');
  end if;
end $$;
