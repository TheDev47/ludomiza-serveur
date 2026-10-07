// Point d'entrée : lit la configuration (variables d'environnement) et démarre.
//
// Variables (fichier /etc/ludomiza/serveur.env sur le VPS, jamais dans GitHub) :
//   DATABASE_URL        connexion Postgres avec le rôle « serveur_jeu »   (SECRET)
//   SUPABASE_URL        https://wfzrcmabqzcnajdilktc.supabase.co
//   SUPABASE_ANON_KEY   clé publique (la même que dans le jeu)
//   PORT                8080 par défaut
//   ORIGINES            sites autorisés, séparés par des virgules
//   TOUTES_LES_PARTIES  "oui" = chronomètres aussi pour les parties sans
//                       téléphone connecté au serveur (non par défaut)
//   DB_CA               chemin du certificat Supabase (vérification TLS stricte)

import fs from 'node:fs';
import { creerBase } from './base.js';
import { verificateurSupabase } from './jetons.js';
import { creerServeur, VERSION } from './application.js';

const env = process.env;
for (const cle of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
  if (!env[cle]) {
    console.error(`Configuration manquante : ${cle}`);
    process.exit(1);
  }
}

const ssl = env.DB_CA
  ? { ca: fs.readFileSync(env.DB_CA, 'utf8'), rejectUnauthorized: true }
  : /localhost|127\.0\.0\.1/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false };

const base = creerBase(env.DATABASE_URL, { ssl });
const serveur = creerServeur({
  base,
  verifierJeton: verificateurSupabase(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
  port: Number(env.PORT || 8080),
  hote: env.HOTE || '127.0.0.1',
  // La régie demande la liste des spectateurs (comptes admin seulement) : son
  // adresse est toujours acceptée, en plus de celles du réglage ORIGINES.
  origines: ((o) => (o.length ? [...new Set([...o, 'https://regie.ludomiza.com'])] : o))(
    (env.ORIGINES || '').split(',').map((s) => s.trim()).filter(Boolean)),
  toutesLesParties: env.TOUTES_LES_PARTIES === 'oui',
});

const port = await serveur.demarrer();
console.log(`LudoMiza serveur de jeu ${VERSION} — port ${port}`);

async function arret(signal) {
  console.log(`Arrêt demandé (${signal})…`);
  await serveur.arreter().catch(() => {});
  await base.fermer().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => arret('SIGTERM'));
process.on('SIGINT', () => arret('SIGINT'));
