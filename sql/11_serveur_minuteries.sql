-- ============================================================================
-- Minuteries appelées par le serveur de jeu (0.17.0)
--
-- Fin des parties chrono à l'heure (_chronos_finir) et départ des tournois
-- (_tournois_depart), toutes les 2 s par le serveur de jeu. Avant : deux tâches
-- pg_cron toutes les 2 s et 5 s, soit ~120 000 lignes de journal par jour chez
-- Supabase (quota « Log Ingestion »). Les tâches pg_cron restent en filet de
-- sécurité toutes les 30 s si le serveur de jeu s'arrête. Les deux fonctions
-- verrouillent ce qu'elles traitent (for update skip locked) : un double appel
-- (serveur + filet) ne fait rien deux fois.
-- ============================================================================
create or replace function public._serveur_minuteries()
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_chronos int := 0; v_tournois boolean := true;
begin
  begin
    v_chronos := public._chronos_finir();
  exception when others then v_chronos := -1;
  end;
  begin
    perform public._tournois_depart();
  exception when others then v_tournois := false;
  end;
  return jsonb_build_object('chronos', v_chronos, 'tournois', v_tournois);
end $function$;

revoke all on function public._serveur_minuteries() from public, anon, authenticated;
grant execute on function public._serveur_minuteries() to serveur_jeu;

-- Filet de sécurité : pg_cron toutes les 30 s au lieu de 2 s / 5 s
do $do$
begin
  if to_regclass('cron.job') is not null then
    perform cron.alter_job(jobid, schedule => '30 seconds') from cron.job
     where jobname in ('ludomiza-chronos', 'ludomiza-tournois-depart');
  end if;
end $do$;
