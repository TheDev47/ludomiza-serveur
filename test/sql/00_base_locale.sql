-- ============================================================================
-- COPIE LOCALE, POUR LES TESTS UNIQUEMENT.
-- Reproduit la partie « jeu » de la base Supabase de production
-- (tables, déclencheurs et fonctions de jeu, recopiés le 30/09/2026),
-- avec de petits bouchons pour ce que Supabase fournit (auth.uid, rôles).
-- Ne jamais exécuter ce fichier sur la vraie base.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;

-- ---------------------------------------------------------------- tables ----
create table public.app_settings (cle text not null, valeur jsonb not null, libelle text not null, groupe text default 'plateforme'::text not null, visible_joueur boolean default false not null, modifiable boolean default true not null, maj_le timestamp with time zone default now() not null, maj_par uuid, PRIMARY KEY (cle));
create table public.game_exits (game_id uuid not null, player_id uuid not null, reason text not null, created_at timestamp with time zone default now() not null, PRIMARY KEY (game_id, player_id), CHECK ((reason = ANY (ARRAY['abandon'::text, 'timeout'::text]))));
create table public.game_players (id uuid default gen_random_uuid() not null, game_id uuid not null, player_id uuid not null, color text not null, play_order integer not null, is_connected boolean default true not null, mise_paid integer default 0 not null, joined_at timestamp with time zone default now() not null, pawns integer[] default '{-1,-1,-1,-1}'::integer[] not null, missed_turns integer default 0 not null, moved_at timestamp with time zone, rang integer, salle_vu_le timestamp with time zone, UNIQUE (game_id, color), UNIQUE (game_id, player_id), PRIMARY KEY (id));
create table public.games (id uuid default gen_random_uuid() not null, code text not null, host_id uuid not null, mise integer not null, max_players integer not null, mode text default 'classic'::text not null, status text default 'waiting'::text not null, current_turn uuid, last_dice integer, created_at timestamp with time zone default now() not null, started_at timestamp with time zone, ended_at timestamp with time zone, winner_id uuid, dice_owner uuid, must_move boolean default false not null, turn_started_at timestamp with time zone, auto_rolled boolean default false not null, rolled_at timestamp with time zone, prive boolean default false not null, rematch_of uuid, tournoi_id uuid, tour integer, six_de_suite integer default 0 not null, six_annule boolean default false not null, table_no integer, UNIQUE (code), CHECK (((max_players >= 2) AND (max_players <= 4))), PRIMARY KEY (id));
create table public.profiles (id uuid not null, pseudo text not null, avatar_color text default 'yellow'::text not null, balance integer default 0 not null, last_recharge timestamp with time zone, created_at timestamp with time zone default now() not null, phone text, is_admin boolean default false not null, blocked boolean default false not null, is_bot boolean default false not null, langue text default 'fr'::text not null, telephone_change_le timestamp with time zone, testeur boolean default false not null, CHECK ((balance >= 0)) NOT VALID, PRIMARY KEY (id));
-- Présence (0.10.0) : comme sur Supabase
create table public.presence_vue (user_id uuid not null primary key, vu_le timestamp with time zone default now() not null);
create table public.transactions (id uuid default gen_random_uuid() not null, player_id uuid not null, game_id uuid, type text not null, amount integer not null, balance_after integer not null, created_at timestamp with time zone default now() not null, tournoi_id uuid, demande_id uuid, PRIMARY KEY (id));

-- Comme sur Supabase : RLS activé, aucune politique pour le rôle du serveur.
alter table public.app_settings enable row level security;
alter table public.game_exits enable row level security;
alter table public.game_players enable row level security;
alter table public.games enable row level security;
alter table public.profiles enable row level security;
alter table public.transactions enable row level security;

-- ------------------------------------------------------------- réglages ----
create or replace function public.reglage(p_cle text) returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select valeur from public.app_settings where cle = p_cle;
$function$;

create or replace function public.reglage_num(p_cle text, p_defaut numeric) returns numeric language plpgsql stable security definer set search_path to 'public' as $function$
declare v jsonb;
begin
  v := public.reglage(p_cle);
  if v is null or jsonb_typeof(v) <> 'number' then return p_defaut; end if;
  return (v #>> '{}')::numeric;
exception when others then return p_defaut;
end $function$;

-- ------------------------------------------------------ fonctions de jeu ----
create or replace function public._hasard(n integer) returns integer language plpgsql set search_path to '' as $function$
declare x bigint; lim bigint;
begin
  if n is null or n < 1 then raise exception '_hasard: n invalide'; end if;
  lim := (4294967296 / n) * n;
  loop
    x := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when x < lim;
  end loop;
  return 1 + (x % n)::int;
end $function$;

create or replace function public._offset(c text) returns integer language sql immutable set search_path to 'public' as $function$
  select case c when 'yellow' then 0 when 'blue' then 13 when 'red' then 26 when 'green' then 39 else 0 end;
$function$;

create or replace function public._movable(p_pawns integer[], d integer) returns integer[] language plpgsql immutable set search_path to 'public' as $function$
declare i int; res int[] := '{}';
begin
  for i in 1..4 loop
    if p_pawns[i] = -1 then
      if d = 6 then res := res || i; end if;
    elsif p_pawns[i] < 56 and p_pawns[i] + d <= 56 then
      res := res || i;
    end if;
  end loop;
  return res;
end;
$function$;

create or replace function public._next_player(p_game_id uuid, p_current uuid) returns uuid language plpgsql stable set search_path to 'public' as $function$
declare cur int; nxt uuid;
begin
  select play_order into cur from public.game_players where game_id = p_game_id and player_id = p_current;
  select player_id into nxt from public.game_players
   where game_id = p_game_id and play_order > cur and rang is null order by play_order limit 1;
  if nxt is null then
    select player_id into nxt from public.game_players
     where game_id = p_game_id and rang is null order by play_order limit 1;
  end if;
  return nxt;
end $function$;

create or replace function public._auto_pick(p_game_id uuid, p_player uuid, d integer) returns integer language plpgsql stable set search_path to 'public' as $function$
declare
  seat record; i int; nr int; abs_cell int; best int := null; best_rel int := -100;
  safe_cells int[] := array[0,8,13,21,26,34,39,47];
  opp record; opp_pawns int[]; j int;
begin
  select * into seat from public.game_players where game_id = p_game_id and player_id = p_player;
  if seat is null then return null; end if;
  for i in 1..4 loop
    if seat.pawns[i] >= 0 and seat.pawns[i] <= 50 and seat.pawns[i] + d <= 56 then
      nr := seat.pawns[i] + d;
      if not (nr = any(safe_cells)) then
        abs_cell := (public._offset(seat.color) + nr) % 52;
        for opp in select * from public.game_players where game_id = p_game_id and player_id <> p_player and rang is null loop
          opp_pawns := opp.pawns;
          for j in 1..4 loop
            if opp_pawns[j] >= 0 and opp_pawns[j] <= 50
               and ((public._offset(opp.color) + opp_pawns[j]) % 52) = abs_cell then
              return i;
            end if;
          end loop;
        end loop;
      end if;
    end if;
  end loop;
  if d = 6 then
    for i in 1..4 loop if seat.pawns[i] = -1 then return i; end if; end loop;
  end if;
  for i in 1..4 loop
    if seat.pawns[i] >= 0 and seat.pawns[i] < 56 and seat.pawns[i] + d <= 56 then
      if seat.pawns[i] > best_rel then best_rel := seat.pawns[i]; best := i; end if;
    end if;
  end loop;
  return best;
end; $function$;

create or replace function public._pay_winner(p_game_id uuid, p_winner uuid) returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  pot int; commission int; net int; newbal int; taux numeric;
begin
  if exists (select 1 from public.games where id = p_game_id and tournoi_id is not null) then
    perform public._tournoi_table_finie(p_game_id, p_winner);
    return;
  end if;

  select coalesce(-sum(amount), 0) into pot
  from public.transactions
  where game_id = p_game_id and type = 'mise';

  if pot <= 0 then
    select coalesce(count(*) * g.mise, 0) into pot
    from public.game_players gp
    join public.games g on g.id = gp.game_id
    where gp.game_id = p_game_id
    group by g.mise;
  end if;

  taux := public.reglage_num('commission_taux', 0.10);
  if taux < 0 or taux > 0.30 then taux := 0.10; end if;

  commission := floor(pot * taux);
  net := pot - commission;

  update public.profiles set balance = balance + net where id = p_winner returning balance into newbal;

  insert into public.transactions (player_id, game_id, type, amount, balance_after)
  values (p_winner, p_game_id, 'gain', net, newbal);
  insert into public.transactions (player_id, game_id, type, amount, balance_after)
  values (p_winner, p_game_id, 'commission', -commission, newbal);
end;
$function$;

create or replace function public._eliminate_player(p_game_id uuid, p_player uuid, p_reason text) returns json language plpgsql security definer set search_path to 'public' as $function$
declare g record; nxt uuid; nb int; other uuid;
begin
  select * into g from public.games where id = p_game_id;
  if g.tournoi_id is not null then
    raise exception 'tournois non reproduits dans la copie locale';
  end if;
  if g.current_turn = p_player then
    nxt := public._next_player(p_game_id, p_player);
  end if;

  insert into public.game_exits (game_id, player_id, reason)
  values (p_game_id, p_player, p_reason)
  on conflict (game_id, player_id) do nothing;

  delete from public.game_players where game_id = p_game_id and player_id = p_player;
  select count(*) into nb from public.game_players where game_id = p_game_id;

  if nb <= 1 then
    select player_id into other from public.game_players where game_id = p_game_id limit 1;
    if other is not null then
      update public.games
         set status = 'finished', ended_at = now(), winner_id = other,
             must_move = false, last_dice = null, dice_owner = null, auto_rolled = false
       where id = p_game_id;
      perform public._pay_winner(p_game_id, other);
    else
      update public.games set status = 'finished', ended_at = now() where id = p_game_id;
    end if;
  elsif nxt is not null then
    update public.games
       set current_turn = nxt, must_move = false, last_dice = null,
           dice_owner = null, auto_rolled = false
     where id = p_game_id;
  end if;

  return json_build_object('ok', true, 'eliminated', true, 'reason', p_reason);
end; $function$;

create or replace function public._do_move(p_game_id uuid, p_player uuid, p_index integer) returns json language plpgsql security definer set search_path to 'public' as $function$
declare
  g record; seat record; d int; cur int; newpos int; abs_cell int;
  captured boolean := false; finished_now boolean := false; won boolean := false;
  opp record; opp_pawns int[]; j int; done_count int;
  safe_cells int[] := array[0,8,13,21,26,34,39,47]; replay boolean := false;
  t_move timestamptz := now();
begin
  select * into g from public.games where id = p_game_id for update;
  if g is null or g.status <> 'playing' then return json_build_object('ok', false, 'error', 'not_playing'); end if;
  if not g.must_move then return json_build_object('ok', false, 'error', 'roll_first'); end if;

  d := g.last_dice;
  select * into seat from public.game_players where game_id = p_game_id and player_id = p_player;
  if seat is null then return json_build_object('ok', false, 'error', 'no_seat'); end if;
  if p_index < 1 or p_index > 4 then return json_build_object('ok', false, 'error', 'bad_index'); end if;

  cur := seat.pawns[p_index];
  if cur = -1 then
    if d <> 6 then return json_build_object('ok', false, 'error', 'illegal'); end if;
    newpos := 0;
  else
    if cur >= 56 or cur + d > 56 then return json_build_object('ok', false, 'error', 'illegal'); end if;
    newpos := cur + d;
  end if;

  seat.pawns[p_index] := newpos;
  update public.game_players set pawns = seat.pawns, moved_at = t_move
    where game_id = p_game_id and player_id = p_player;

  if newpos >= 0 and newpos <= 50 and not (newpos = any(safe_cells)) then
    abs_cell := (public._offset(seat.color) + newpos) % 52;
    for opp in select * from public.game_players where game_id = p_game_id and player_id <> p_player and rang is null loop
      opp_pawns := opp.pawns;
      for j in 1..4 loop
        if opp_pawns[j] >= 0 and opp_pawns[j] <= 50
           and ((public._offset(opp.color) + opp_pawns[j]) % 52) = abs_cell then
          if (select count(*) from unnest(opp_pawns) x where x >= 0 and x <= 50
                and ((public._offset(opp.color) + x) % 52) = abs_cell) = 1 then
            opp_pawns[j] := -1; captured := true;
          end if;
        end if;
      end loop;
      if captured then
        update public.game_players set pawns = opp_pawns, moved_at = t_move
          where game_id = p_game_id and player_id = opp.player_id;
      end if;
    end loop;
  end if;

  if newpos = 56 then finished_now := true; end if;

  done_count := (case when seat.pawns[1]=56 then 1 else 0 end)
              + (case when seat.pawns[2]=56 then 1 else 0 end)
              + (case when seat.pawns[3]=56 then 1 else 0 end)
              + (case when seat.pawns[4]=56 then 1 else 0 end);

  if g.mode = 'fast' then      won := (done_count >= 1);
  elsif g.mode = 'two' then    won := (done_count >= 2);
  else                         won := (done_count >= 4);
  end if;

  if won then
    update public.games set status='finished', ended_at=now(), winner_id=p_player,
                            must_move=false, last_dice=null, dice_owner=null where id=p_game_id;
    perform public._pay_winner(p_game_id, p_player);
    return json_build_object('ok', true, 'won', true);
  end if;

  replay := (d = 6 or captured or finished_now);
  if replay then
    update public.games set must_move = false, last_dice = null, dice_owner = null,
           current_turn = p_player, turn_started_at = now() where id = p_game_id;
  else
    update public.games set must_move = false, last_dice = null, dice_owner = null,
           current_turn = public._next_player(p_game_id, p_player) where id = p_game_id;
  end if;

  return json_build_object('ok', true, 'captured', captured, 'finished', finished_now, 'replay', replay);
end; $function$;

create or replace function public._touch_turn() returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if new.current_turn is distinct from old.current_turn then
    new.turn_started_at := now();
  elsif old.must_move and not new.must_move and new.status = 'playing' then
    new.turn_started_at := now();
  end if;
  return new;
end $function$;

create or replace function public._regle_trois_six() returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.rolled_at is distinct from old.rolled_at and new.last_dice is not null then
    new.six_annule := false;
    if new.last_dice = 6 then
      if old.six_de_suite >= 2 and old.current_turn = new.dice_owner then
        new.must_move := false;
        new.auto_rolled := false;
        new.current_turn := public._next_player(new.id, new.dice_owner);
        new.six_de_suite := 0;
        new.six_annule := true;
      elsif new.current_turn is distinct from new.dice_owner then
        new.six_de_suite := 0;
      else
        new.six_de_suite := case when old.current_turn = new.dice_owner then old.six_de_suite else 0 end + 1;
      end if;
    else
      new.six_de_suite := 0;
    end if;
  elsif new.current_turn is distinct from old.current_turn then
    new.six_de_suite := 0;
  end if;
  return new;
end $function$;

create trigger trg_touch_turn before update on public.games for each row execute function _touch_turn();
create trigger trg_a_trois_six before update on public.games for each row execute function _regle_trois_six();

create or replace function public._start_game(p_game_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare
  g record; seat record; prof record;
  first_id uuid; nb int; palette text[]; i int := 1; newbal int;
begin
  select * into g from public.games where id = p_game_id for update;
  if g is null then return json_build_object('ok', false, 'error', 'game_not_found'); end if;
  if g.status <> 'waiting' then return json_build_object('ok', false, 'error', 'already_started'); end if;

  select count(*) into nb from public.game_players where game_id = p_game_id;
  if nb < 2 then return json_build_object('ok', false, 'error', 'need_2_players'); end if;

  if nb = 2 then palette := array['yellow','red'];
  elsif nb = 3 then palette := array['yellow','blue','green'];
  else palette := array['yellow','blue','red','green'];
  end if;

  for prof in
    select p.id, p.balance, p.blocked from public.profiles p
    join public.game_players gp on gp.player_id = p.id
    where gp.game_id = p_game_id order by p.id for update of p
  loop
    if prof.blocked then return json_build_object('ok', false, 'error', 'player_blocked'); end if;
    if prof.balance < g.mise then return json_build_object('ok', false, 'error', 'player_no_funds'); end if;
  end loop;

  update public.game_players set color = 'tmp' || play_order where game_id = p_game_id;

  for seat in
    select gp.player_id from public.game_players gp where gp.game_id = p_game_id order by gp.play_order
  loop
    update public.profiles set balance = balance - g.mise
     where id = seat.player_id returning balance into newbal;
    insert into public.transactions (player_id, game_id, type, amount, balance_after)
    values (seat.player_id, p_game_id, 'mise', -g.mise, newbal);
    update public.game_players
       set mise_paid = g.mise, color = palette[i], pawns = '{-1,-1,-1,-1}', missed_turns = 0
     where game_id = p_game_id and player_id = seat.player_id;
    i := i + 1;
  end loop;

  select player_id into first_id from public.game_players
   where game_id = p_game_id order by play_order limit 1;

  update public.games
     set status = 'playing', started_at = now(), current_turn = first_id,
         last_dice = null, dice_owner = null, must_move = false,
         auto_rolled = false, rolled_at = null
   where id = p_game_id;
  update public.games set turn_started_at = now() + interval '5 seconds' where id = p_game_id;

  return json_build_object('ok', true,
    'game', (select row_to_json(x) from public.games x where x.id = p_game_id));
end $function$;

create or replace function public.roll_dice(p_game_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid(); g record; seat record; d int; mv int[];
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into g from public.games where id = p_game_id for update;
  if g is null or g.status <> 'playing' then return json_build_object('ok', false, 'error', 'not_playing'); end if;
  if g.current_turn <> me then return json_build_object('ok', false, 'error', 'not_your_turn'); end if;
  if g.must_move then return json_build_object('ok', false, 'error', 'must_move_first'); end if;
  if g.turn_started_at is not null and g.turn_started_at > now() + interval '1 second' then
    return json_build_object('ok', false, 'error', 'pas_encore');
  end if;

  select * into seat from public.game_players where game_id = p_game_id and player_id = me;
  d := public._hasard(6);
  mv := public._movable(seat.pawns, d);

  if array_length(mv, 1) is null then
    update public.games set last_dice = d, dice_owner = me, must_move = false,
           auto_rolled = false, rolled_at = now(),
           current_turn = public._next_player(p_game_id, me) where id = p_game_id;
    return json_build_object('ok', true, 'dice', d, 'movable', false,
      'game', (select row_to_json(x) from public.games x where x.id = p_game_id));
  end if;
  update public.games set last_dice = d, dice_owner = me, must_move = true,
         auto_rolled = false, rolled_at = now() where id = p_game_id;
  return json_build_object('ok', true, 'dice', d, 'movable', true,
      'game', (select row_to_json(x) from public.games x where x.id = p_game_id));
end; $function$;

create or replace function public.move_pawn(p_game_id uuid, p_index integer) returns json language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid(); g record; r json;
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into g from public.games where id = p_game_id;
  if g is null or g.current_turn <> me then return json_build_object('ok', false, 'error', 'not_your_turn'); end if;
  r := public._do_move(p_game_id, me, p_index);
  if coalesce((r->>'ok')::boolean, false) then
    r := (r::jsonb || jsonb_build_object(
      'game', (select to_jsonb(x) from public.games x where x.id = p_game_id),
      'seats', coalesce((select jsonb_agg(jsonb_build_object(
          'player_id', gp.player_id, 'color', gp.color, 'play_order', gp.play_order,
          'pawns', gp.pawns, 'missed_turns', gp.missed_turns, 'moved_at', gp.moved_at, 'rang', gp.rang)
          order by gp.play_order)
        from public.game_players gp where gp.game_id = p_game_id), '[]'::jsonb)))::json;
  end if;
  return r;
end; $function$;

create or replace function public.force_move(p_game_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare g record; cur uuid; idx int; nb int;
begin
  if not exists (select 1 from public.game_players where game_id = p_game_id and player_id = auth.uid()) then
    return json_build_object('ok', false, 'error', 'not_in_game');
  end if;
  select * into g from public.games where id = p_game_id for update;
  if g is null or g.status <> 'playing' then return json_build_object('ok', false, 'error', 'not_playing'); end if;
  if not g.must_move then return json_build_object('ok', false, 'error', 'nothing_to_move'); end if;
  if g.turn_started_at is not null and now() - g.turn_started_at < interval '19 seconds' then
    return json_build_object('ok', false, 'error', 'too_early');
  end if;
  if now() - coalesce(g.rolled_at, g.turn_started_at, now() - interval '1 hour')
     < (case when g.auto_rolled then interval '2 seconds' else interval '9 seconds' end) then
    return json_build_object('ok', false, 'error', 'too_early');
  end if;

  cur := g.current_turn;
  if not g.auto_rolled then
    update public.game_players set missed_turns = missed_turns + 1
     where game_id = p_game_id and player_id = cur returning missed_turns into nb;
    if nb >= 5 then
      return public._eliminate_player(p_game_id, cur, 'timeout');
    end if;
  end if;

  idx := public._auto_pick(p_game_id, cur, g.last_dice);
  if idx is null then
    update public.games set must_move = false, last_dice = null, dice_owner = null, auto_rolled = false,
           current_turn = public._next_player(p_game_id, cur) where id = p_game_id;
    return json_build_object('ok', true, 'auto', 'no_move');
  end if;
  return public._do_move(p_game_id, cur, idx);
end; $function$;

create or replace function public.force_turn(p_game_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare g record; cur uuid; d int; mv int[]; seat record; nb int;
begin
  if not exists (select 1 from public.game_players where game_id = p_game_id and player_id = auth.uid()) then
    return json_build_object('ok', false, 'error', 'not_in_game');
  end if;
  select * into g from public.games where id = p_game_id for update;
  if g is null or g.status <> 'playing' then return json_build_object('ok', false, 'error', 'not_playing'); end if;
  if g.turn_started_at is not null and now() - g.turn_started_at < interval '17 seconds' then
    return json_build_object('ok', false, 'error', 'too_early');
  end if;
  if g.must_move then return json_build_object('ok', false, 'error', 'already_rolled'); end if;

  cur := g.current_turn;
  select * into seat from public.game_players where game_id = p_game_id and player_id = cur;
  if seat is null then
    update public.games
       set current_turn = (select player_id from public.game_players where game_id = p_game_id order by play_order limit 1),
           must_move = false, last_dice = null, dice_owner = null, auto_rolled = false
     where id = p_game_id;
    return json_build_object('ok', true, 'skipped', true);
  end if;

  update public.game_players set missed_turns = missed_turns + 1
   where game_id = p_game_id and player_id = cur returning missed_turns into nb;
  if nb >= 5 then
    return public._eliminate_player(p_game_id, cur, 'timeout');
  end if;

  d := public._hasard(6);
  mv := public._movable(seat.pawns, d);
  if array_length(mv, 1) is null then
    update public.games set last_dice = d, dice_owner = cur, must_move = false,
           auto_rolled = false, rolled_at = now(),
           current_turn = public._next_player(p_game_id, cur) where id = p_game_id;
    return json_build_object('ok', true, 'rolled', d, 'movable', false, 'missed', nb);
  end if;
  update public.games set last_dice = d, dice_owner = cur, must_move = true,
         auto_rolled = true, rolled_at = now() where id = p_game_id;
  return json_build_object('ok', true, 'rolled', d, 'movable', true, 'missed', nb);
end; $function$;

create or replace function public.leave_game(p_game_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare me uuid := auth.uid(); g record; nb int;
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into g from public.games where id = p_game_id for update;
  if g is null then return json_build_object('ok', false, 'error', 'game_not_found'); end if;

  if g.status = 'finished' then
    delete from public.game_players where game_id = p_game_id and player_id = me;
    return json_build_object('ok', true);
  end if;

  if not exists (select 1 from public.game_players where game_id = p_game_id and player_id = me) then
    return json_build_object('ok', false, 'error', 'not_in_game');
  end if;

  if g.status = 'waiting' then
    delete from public.game_players where game_id = p_game_id and player_id = me;
    select count(*) into nb from public.game_players where game_id = p_game_id;
    if me = g.host_id or nb = 0 then
      update public.games set status = 'finished', ended_at = now() where id = p_game_id;
    end if;
    return json_build_object('ok', true);
  end if;

  return public._eliminate_player(p_game_id, me, 'abandon');
end; $function$;


-- ------------------------------------------------------------- stickers ----
create table public.emoji_catalogue (emoji text not null, famille text not null, prix integer not null, rang integer default 0 not null, actif boolean default true not null, PRIMARY KEY (emoji));
create table public.game_emojis (id bigint generated always as identity, game_id uuid not null, de uuid not null, a uuid not null, emoji text not null, prix integer not null, created_at timestamp with time zone default now() not null, PRIMARY KEY (id));
alter table public.emoji_catalogue enable row level security;
alter table public.game_emojis enable row level security;

create or replace function public.reglage_bool(p_cle text, p_defaut boolean) returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare v jsonb;
begin
  v := public.reglage(p_cle);
  if v is null or jsonb_typeof(v) <> 'boolean' then return p_defaut; end if;
  return (v #>> '{}')::boolean;
exception when others then return p_defaut;
end $function$;

create or replace function public._emojis_autorises() returns text[] language sql stable set search_path to 'public' as $function$
  select coalesce(array_agg(emoji), '{}') from public.emoji_catalogue where actif
$function$;

create or replace function public.envoyer_emoji(p_game_id uuid, p_emoji text, p_cible uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare
  me uuid := auth.uid();
  v_prix int;
  v_bal int;
  v_statut text;
  v_dernier timestamptz;
begin
  if me is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.reglage_bool('emoji_actif', true) then
    return json_build_object('ok', false, 'error', 'emojis_desactives');
  end if;
  if p_emoji is null or not (p_emoji = any(public._emojis_autorises())) then
    return json_build_object('ok', false, 'error', 'emoji_inconnu');
  end if;

  select status into v_statut from public.games where id = p_game_id;
  if v_statut is distinct from 'playing' then return json_build_object('ok', false, 'error', 'not_playing'); end if;
  if not exists (select 1 from public.game_players where game_id = p_game_id and player_id = me) then
    return json_build_object('ok', false, 'error', 'pas_a_la_table');
  end if;
  if exists (select 1 from public.game_players where game_id = p_game_id and player_id = me and rang is not null) then
    return json_build_object('ok', false, 'error', 'deja_arrive');
  end if;
  if p_cible is null or p_cible = me
     or not exists (select 1 from public.game_players where game_id = p_game_id and player_id = p_cible) then
    return json_build_object('ok', false, 'error', 'cible_invalide');
  end if;

  select max(created_at) into v_dernier from public.game_emojis where game_id = p_game_id and de = me;
  if v_dernier is not null and v_dernier > now() - interval '3 seconds' then
    return json_build_object('ok', false, 'error', 'trop_rapide');
  end if;

  select greatest(0, prix) into v_prix from public.emoji_catalogue where emoji = p_emoji and actif;
  select balance into v_bal from public.profiles where id = me and not coalesce(blocked, false) for update;
  if v_bal is null then return json_build_object('ok', false, 'error', 'blocked'); end if;
  if v_bal < v_prix then return json_build_object('ok', false, 'error', 'insufficient', 'prix', v_prix); end if;

  if v_prix > 0 then
    update public.profiles set balance = balance - v_prix where id = me returning balance into v_bal;
    insert into public.transactions (player_id, game_id, type, amount, balance_after)
    values (me, p_game_id, 'emoji', -v_prix, v_bal);
  end if;

  insert into public.game_emojis (game_id, de, a, emoji, prix) values (p_game_id, me, p_cible, p_emoji, v_prix);
  return json_build_object('ok', true, 'prix', v_prix, 'solde', v_bal);
end $function$;

insert into public.emoji_catalogue (emoji, famille, prix, rang) values ('👍', 'taquiner', 10, 1), ('💣', 'taquiner', 10, 2);

-- Droits comme en production (vérifié le 30/09/2026) : les fonctions « _ »
-- ne sont exécutables que par postgres ; celles du jeu par « authenticated ».
grant usage on schema public to anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.roll_dice(uuid), public.move_pawn(uuid, integer), public.force_turn(uuid),
  public.force_move(uuid), public.leave_game(uuid), public.envoyer_emoji(uuid, text, uuid) to authenticated;
-- Supabase donne par défaut EXECUTE aux joueurs sur les NOUVELLES fonctions :
-- on le reproduit pour vérifier que la migration du serveur le retire bien.
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Tables hors partie (ajoutées le 01/10/2026 pour les signaux de 04_serveur_signaux.sql).
-- Structure réduite aux colonnes utiles, conforme à la production.
create table if not exists public.notifications (id uuid default gen_random_uuid() primary key, user_id uuid not null, type text not null, actor_id uuid, game_id uuid, data jsonb default '{}'::jsonb, read boolean default false not null, created_at timestamp with time zone default now() not null);
create table if not exists public.friendships (id uuid default gen_random_uuid() primary key, requester_id uuid not null, addressee_id uuid not null, status text default 'pending' not null, created_at timestamp with time zone default now() not null);
create table if not exists public.payment_requests (id uuid default gen_random_uuid() primary key, user_id uuid not null, kind text not null, amount integer not null, operator text not null, phone text not null, status text default 'pending', created_at timestamp with time zone default now());
create table if not exists public.support_chat (id uuid default gen_random_uuid() primary key, user_id uuid not null, sender text not null, body text not null, read_by_user boolean default false not null, read_by_admin boolean default false not null, created_at timestamp with time zone default now() not null);
