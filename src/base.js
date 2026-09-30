// Accès à la base Supabase.
//
// Le serveur n'utilise que deux fonctions internes (voir sql/01_serveur_jeu.sql) :
//   _serveur_etat   : lire l'état d'une ou plusieurs parties
//   _serveur_action : jouer une action au nom d'un joueur + état à jour
// Chaque appel = un seul aller-retour avec la base.

import pg from 'pg';

export function creerBase(adresse, { ssl, max = 8 } = {}) {
  const pool = new pg.Pool({
    connectionString: adresse,
    max,
    ssl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ludomiza-serveur',
  });
  // Une connexion qui tombe côté base ne doit pas arrêter le serveur.
  pool.on('error', (e) => console.error('[base] connexion perdue :', e.message));

  return {
    async etat(ids, actives = false) {
      const r = await pool.query('select public._serveur_etat($1::uuid[], $2) as e', [ids ?? [], actives]);
      return r.rows[0].e ?? [];
    },
    async action(joueur, partie, action, pion = null) {
      const r = await pool.query(
        'select public._serveur_action($1::uuid, $2::uuid, $3, $4::int) as r',
        [joueur, partie, action, pion],
      );
      return r.rows[0].r;
    },
    async emoji(joueur, partie, emoji, cible) {
      const r = await pool.query(
        'select public._serveur_emoji($1::uuid, $2::uuid, $3, $4::uuid) as r',
        [joueur, partie, emoji, cible],
      );
      return r.rows[0].r;
    },
    async fermer() {
      await pool.end();
    },
  };
}
