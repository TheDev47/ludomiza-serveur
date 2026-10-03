// Protocole 2 (serveur 0.5.0) : différences, reprise après coupure, compression.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { creerBase } from '../src/base.js';
import { creerServeur } from '../src/application.js';
import { creerBaseDeTest, creerJoueurs, creerPartie, verifierJetonDeTest, Robot, attendre } from './aide.js';

let bd, base, serveur, url;

before(async () => {
  bd = await creerBaseDeTest();
  base = creerBase(bd.urlServeur, { ssl: false });
  serveur = creerServeur({
    base, verifierJeton: verifierJetonDeTest, port: 0, hote: '127.0.0.1',
    sondageMs: 300, journal: { error: () => {}, log: () => {} },
  });
  const port = await serveur.demarrer();
  url = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await serveur.arreter();
  await base.fermer();
  await bd.detruire();
});

async function etatBase(partie) {
  const [e] = await base.etat([partie]);
  return e;
}

// Même contenu, quel que soit l'ordre des clés.
const norme = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)));

test('table mixte : un ancien téléphone et un récent jouent une partie complète, mêmes états', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 500, mode: 'fast' });
  const ancien = await new Robot(joueurs[0]).connecter(url, partie);
  const recent = await new Robot(joueurs[1], { proto: 2 }).connecter(url, partie);
  assert.equal(recent.bienvenue.proto, 2);
  assert.equal(ancien.bienvenue.proto, 1);

  await attendre(() => [ancien, recent].every((r) => r.etat?.game.status === 'finished'), 120_000);
  await new Promise((r) => setTimeout(r, 300));
  const fin = await etatBase(partie);
  assert.deepEqual(norme(recent.local.game), norme(fin.game), 'partie reconstruite = base');
  assert.deepEqual(norme(recent.local.seats), norme(fin.seats), 'sièges reconstruits = base');
  assert.deepEqual(norme(ancien.etat.game), norme(fin.game));
  assert.equal(recent.reprisesDemandees, 0, 'aucune différence qui ne s’applique pas');
  assert.ok(recent.maj > 10, 'le téléphone récent reçoit des différences');
  assert.equal(recent.complets, 1, 'un seul état complet (à l’arrivée)');
  const refus = [ancien, recent].flatMap((r) => r.reponses.filter((x) => !x.ok));
  assert.deepEqual(refus, []);
  // L'argent : le gagnant touche 900
  const { rows } = await bd.su.query('select id, balance from profiles where id = any($1)', [joueurs]);
  const s = Object.fromEntries(rows.map((r) => [r.id, r.balance]));
  assert.equal(s[fin.game.winner_id], 10_000 - 500 + 900);
  console.log(`  ${recent.maj} différences reçues, ${recent.complets} état complet`);
  ancien.fermer(); recent.fermer();
});

test('poids : différences + compression contre états complets sans compression', async () => {
  // Deux parties identiques dans leur forme ; on compare les octets reçus par coup.
  const mesurer = async (opts) => {
    const joueurs = await creerJoueurs(bd.su, 2);
    const partie = await creerPartie(bd.su, joueurs, { mise: 100, mode: 'fast' });
    const robots = await Promise.all(joueurs.map((j) => new Robot(j, opts).connecter(url, partie)));
    await attendre(() => robots.every((r) => r.etat?.game.status === 'finished'), 120_000);
    await new Promise((r) => setTimeout(r, 300));
    const octets = robots.reduce((a, r) => a + r.octetsReseau(), 0);
    const messages = robots.reduce((a, r) => a + r.etats.length, 0);
    robots.forEach((r) => r.fermer());
    return { parMessage: octets / messages, messages };
  };
  const avant = await mesurer({ proto: 1, compression: false });
  const apres = await mesurer({ proto: 2, compression: true });
  const gain = avant.parMessage / apres.parMessage;
  console.log(`  avant : ${Math.round(avant.parMessage)} octets par mise à jour · après : ${Math.round(apres.parMessage)} octets (÷${gain.toFixed(1)})`);
  assert.ok(gain > 3, `au moins 3 fois plus léger (÷${gain.toFixed(1)})`);
});

test('reprise : après une coupure, seulement ce qui a changé', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 100, mode: 'fast' });
  const a = await new Robot(joueurs[0], { proto: 2 }).connecter(url, partie);
  const b = await new Robot(joueurs[1], { proto: 2 }).connecter(url, partie);
  await attendre(() => b.local?.v >= 6, 20_000);
  // b perd le réseau ; a continue de jouer seul… et b reviendra
  const depuis = { ep: b.local.ep, v: b.local.v };
  b.fermer();
  // Pendant la coupure, a lance au moins une fois (les tours de b passent au chronomètre ou non : peu importe)
  await attendre(() => a.local?.v >= depuis.v + 2, 30_000);
  const b2 = new Robot(joueurs[1], { proto: 2, depuis });
  b2.local = { ...b.local };          // le téléphone garde sa copie
  b2.complets = 0;
  await b2.connecter(url, partie);
  await attendre(() => b2.maj >= 1, 5000);
  assert.equal(b2.complets, 0, 'pas d’état complet à la reprise');
  assert.equal(b2.reprisesDemandees, 0);
  await new Promise((r) => setTimeout(r, 200));
  const e = await etatBase(partie);
  // Même version que le serveur, même contenu que la base (si rien n'a bougé entre-temps)
  if (b2.local.v === serveur.parties.get(partie).version) {
    assert.deepEqual(norme(b2.local.game), norme(serveur.parties.get(partie).etat.game));
  }
  assert.equal(b2.local.seats.length, e.seats.length);
  a.fermer(); b2.fermer();
});

test('reprise : version inconnue (serveur redémarré) → état complet', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 100 });
  const r = await new Robot(joueurs[0], { proto: 2, dort: true, depuis: { ep: 'autre', v: 3 } }).connecter(url, partie);
  await attendre(() => r.complets === 1, 3000);
  assert.equal(r.maj, 0);
  r.fermer();
});

test('perte du fil : une différence qui ne s’applique pas → le téléphone redemande tout', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 100 });
  const r = await new Robot(joueurs[0], { proto: 2, dort: true }).connecter(url, partie);
  await attendre(() => r.complets === 1, 3000);
  r.local.v -= 5;   // copie volontairement en retard
  await bd.su.query("update games set turn_started_at = now() where id = $1", [partie]);
  await attendre(() => r.reprisesDemandees === 1 && r.complets === 2, 5000);
  assert.equal(r.local.v, serveur.parties.get(partie).version);
  r.fermer();
});

test('compression négociée avec le téléphone', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 100 });
  const r = await new Robot(joueurs[0], { proto: 2, dort: true }).connecter(url, partie);
  assert.match(r.ws.extensions, /permessage-deflate/);
  r.fermer();
});
