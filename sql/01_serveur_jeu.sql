-- ============================================================================
-- Serveur de jeu LudoMiza : accès limité à la base.
--
-- Le serveur de jeu ne recopie AUCUNE règle : il appelle les fonctions qui
-- existent déjà (roll_dice, move_pawn, force_turn, force_move, leave_game)
-- au nom du joueur dont il a vérifié le jeton de connexion.
--
-- Il se connecte avec un rôle à part, « serveur_jeu », qui ne peut rien faire
-- d'autre qu'appeler les deux fonctions internes ci-dessous. Pas de lecture
-- directe des tables, pas d'accès aux soldes.
--
-- Le mot de passe de ce rôle n'est PAS dans ce fichier : Jordan le crée
-- lui-même dans l'éditeur SQL de Supabase (voir LISEZ-MOI).
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'serveur_jeu') then
    create role serveur_jeu nologin noinherit;
  end if;
end $$;

-- État d'une ou plusieurs parties, sous la même forme que la réponse de
-- move_pawn (game + seats), plus l'heure exacte de la base.
--   p_ids     : parties demandées (peuvent être terminées)
--   p_actives : ajouter toutes les parties en cours
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
           'maintenant', clock_timestamp())
         order by g.id), '[]'::jsonb)
    from public.games g
   where (p_actives and g.status = 'playing')
      or g.id = any(coalesce(p_ids, '{}'::uuid[]));
$function$;

-- Une action de jeu, au nom d'un joueur, puis l'état à jour de la partie.
-- Tout se fait en UN seul aller-retour avec la base.
--   lancer       -> roll_dice
--   jouer        -> move_pawn(p_pion)
--   quitter      -> leave_game
--   forcer_tour  -> force_turn  (chronomètre écoulé avant le lancer)
--   forcer_pion  -> force_move  (chronomètre écoulé avant le déplacement)
-- Pour « forcer_* », le joueur est choisi ici (celui qui a la main, sinon le
-- premier assis) : ces fonctions exigent seulement d'être assis à la table,
-- et vérifient elles-mêmes que le délai est bien écoulé.
create or replace function public._serveur_action(p_joueur uuid, p_partie uuid, p_action text, p_pion integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r json;
  qui uuid := p_joueur;
begin
  if p_action in ('forcer_tour', 'forcer_pion') then
    select coalesce(
             (select gp.player_id from public.game_players gp
               where gp.game_id = p_partie
                 and gp.player_id = (select g.current_turn from public.games g where g.id = p_partie)),
             (select gp.player_id from public.game_players gp
               where gp.game_id = p_partie order by gp.play_order limit 1))
      into qui;
    if qui is null then
      return jsonb_build_object('resultat', json_build_object('ok', false, 'error', 'no_seat'),
                                'etat', public._serveur_etat(array[p_partie]) -> 0);
    end if;
  end if;

  if qui is null then
    return jsonb_build_object('resultat', json_build_object('ok', false, 'error', 'not_authenticated'),
                              'etat', public._serveur_etat(array[p_partie]) -> 0);
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', qui, 'role', 'authenticated')::text, true);

  if p_action = 'lancer' then
    r := public.roll_dice(p_partie);
  elsif p_action = 'jouer' then
    r := public.move_pawn(p_partie, p_pion);
  elsif p_action = 'quitter' then
    r := public.leave_game(p_partie);
  elsif p_action = 'forcer_tour' then
    r := public.force_turn(p_partie);
  elsif p_action = 'forcer_pion' then
    r := public.force_move(p_partie);
  else
    r := json_build_object('ok', false, 'error', 'action_inconnue');
  end if;

  perform set_config('request.jwt.claims', '', true);

  -- move_pawn renvoie déjà game + seats : inutile de les renvoyer deux fois.
  return jsonb_build_object(
    'resultat', (r::jsonb - 'game' - 'seats'),
    'etat', public._serveur_etat(array[p_partie]) -> 0);
end
$function$;

-- Règle maison : les fonctions internes « _ » ne sont pas appelables
-- par les joueurs (anon / authenticated).
revoke all on function public._serveur_etat(uuid[], boolean) from public, anon, authenticated;
revoke all on function public._serveur_action(uuid, uuid, text, integer) from public, anon, authenticated;

grant usage on schema public to serveur_jeu;
grant execute on function public._serveur_etat(uuid[], boolean) to serveur_jeu;
grant execute on function public._serveur_action(uuid, uuid, text, integer) to serveur_jeu;
