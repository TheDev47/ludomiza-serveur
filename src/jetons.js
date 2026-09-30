// Vérification du jeton de connexion d'un joueur.
//
// On demande simplement à Supabase « à qui appartient ce jeton ? »
// (même vérification que pour n'importe quelle requête du jeu).
// La réponse est gardée 5 minutes pour ne pas redemander à chaque reconnexion.

const DUREE_CACHE_MS = 5 * 60_000;

export function verificateurSupabase(url, cleAnon) {
  if (!url || !cleAnon) throw new Error('SUPABASE_URL et SUPABASE_ANON_KEY sont obligatoires');
  const cache = new Map();

  return async function verifier(jeton) {
    if (typeof jeton !== 'string' || jeton.length < 20 || jeton.length > 4096) return null;
    const connu = cache.get(jeton);
    if (connu && connu.fin > Date.now()) return connu.uid;

    let rep;
    try {
      rep = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: cleAnon, Authorization: `Bearer ${jeton}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return null;
    }
    if (!rep.ok) return null;
    const u = await rep.json().catch(() => null);
    if (!u?.id) return null;

    if (cache.size > 5000) cache.clear();
    cache.set(jeton, { uid: u.id, fin: Date.now() + DUREE_CACHE_MS });
    return u.id;
  };
}
