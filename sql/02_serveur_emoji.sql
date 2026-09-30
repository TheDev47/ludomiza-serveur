-- ============================================================================
-- Serveur de jeu : les stickers passent aussi par le serveur.
--
-- Le serveur appelle la fonction qui existe déjà (envoyer_emoji : vérifie le
-- catalogue, le délai de 3 s, le solde, et prend le prix) au nom du joueur
-- vérifié, puis renvoie la ligne enregistrée pour la diffuser aussitôt à
-- toute la table. Fonction à part (pas de nouvel argument à _serveur_action),
-- pour qu'un serveur encore dans l'ancienne version continue de fonctionner
-- pendant sa mise à jour.
-- ============================================================================

create or replace function public._serveur_emoji(p_joueur uuid, p_partie uuid, p_emoji text, p_cible uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r json;
  ligne record;
begin
  if p_joueur is null then
    return jsonb_build_object('resultat', json_build_object('ok', false, 'error', 'not_authenticated'));
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_joueur, 'role', 'authenticated')::text, true);
  r := public.envoyer_emoji(p_partie, p_emoji, p_cible);
  perform set_config('request.jwt.claims', '', true);

  if coalesce((r->>'ok')::boolean, false) then
    select id, game_id, de, a, emoji, prix, created_at into ligne
      from public.game_emojis
     where game_id = p_partie and de = p_joueur
     order by id desc limit 1;
    return jsonb_build_object('resultat', r::jsonb, 'ligne', to_jsonb(ligne));
  end if;
  return jsonb_build_object('resultat', r::jsonb);
end
$function$;

revoke all on function public._serveur_emoji(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public._serveur_emoji(uuid, uuid, text, uuid) to serveur_jeu;
