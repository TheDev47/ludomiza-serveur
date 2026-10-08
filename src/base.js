// Accès à la base Supabase.
//
// Le serveur n'utilise que des fonctions internes (voir sql/) :
//   _serveur_etat       : lire l'état d'une ou plusieurs parties
//   _serveur_action     : jouer une action au nom d'un joueur + état à jour
//   _serveur_emoji      : envoyer un sticker au nom d'un joueur
//   _serveur_evenements : signaux hors partie (solde, notifications…)
//   _serveur_pseudo     : pseudo d'un spectateur (signature des réactions)
//   _serveur_est_admin  : la régie demande la liste des spectateurs
//   _serveur_presence   : « vu il y a… » et présence en salle, pour tous les connectés
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
    // Signaux hors partie (sql/04_serveur_signaux.sql) : [id, joueur|null, sujet, cle].
    async evenements(apres) {
      const r = await pool.query('select public._serveur_evenements($1::bigint) as e', [apres]);
      return r.rows[0].e ?? { dernier: apres ?? 0, evts: [] };
    },
    async pseudo(joueur) {
      const r = await pool.query('select public._serveur_pseudo($1::uuid) as p', [joueur]);
      return r.rows[0]?.p ?? null;
    },
    async estAdmin(joueur) {
      const r = await pool.query('select public._serveur_est_admin($1::uuid) as a', [joueur]);
      return r.rows[0]?.a === true;
    },
    // Présence des joueurs qui ont l'appli ouverte (sql/07_serveur_presence.sql).
    async presence(ids) {
      const r = await pool.query('select public._serveur_presence($1::uuid[]) as n', [ids]);
      return r.rows[0]?.n ?? 0;
    },
    async fermer() {
      await pool.end();
    },
  };
}
