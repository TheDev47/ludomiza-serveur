import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { creerBase } from '../src/base.js';
import { creerServeur, echeance } from '../src/application.js';
import {
  creerBaseDeTest, creerJoueurs, creerPartie, verifierJetonDeTest, Robot, attendre, jetonDe,
} from './aide.js';

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

async function soldes(ids) {
  const { rows } = await bd.su.query('select id, balance from profiles where id = any($1)', [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.balance]));
}

test('partie rapide complète à 2 robots, jusqu’au paiement du gagnant', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs, { mise: 500, mode: 'fast' });
  const robots = await Promise.all(joueurs.map((j) => new Robot(j).connecter(url, partie)));

  const fin = await attendre(() => robots.every((r) => r.etat?.game.status === 'finished') && robots[0].etat, 120_000);
  const gagnant = fin.game.winner_id;
  assert.ok(joueurs.includes(gagnant), 'un gagnant désigné');

  // Argent : pot 1000, commission 10 % = 100, le gagnant reçoit 900.
  const s = await soldes(joueurs);
  const perdant = joueurs.find((j) => j !== gagnant);
  assert.equal(s[gagnant], 10_000 - 500 + 900);
  assert.equal(s[perdant], 10_000 - 500);

  // Aucun coup refusé à un robot qui jouait à son tour.
  const refus = robots.flatMap((r) => r.reponses.filter((x) => !x.ok));
  assert.deepEqual(refus, []);

  const lat = robots.flatMap((r) => r.latences).sort((a, b) => a - b);
  console.log(`  ${lat.length} coups relayés — latence adversaire médiane ${lat[lat.length >> 1]} ms, max ${lat.at(-1)} ms (base locale)`);
  robots.forEach((r) => r.fermer());
});

test('partie à 4 robots (mode « deux pions »), sans coup refusé', async () => {
  const joueurs = await creerJoueurs(bd.su, 4);
  const partie = await creerPartie(bd.su, joueurs, { mise: 200, mode: 'two' });
  const robots = await Promise.all(joueurs.map((j) => new Robot(j).connecter(url, partie)));
  const fin = await attendre(() => robots.every((r) => r.etat?.game.status === 'finished') && robots[0].etat, 240_000);
  assert.ok(joueurs.includes(fin.game.winner_id));
  const s = await soldes(joueurs);
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  assert.equal(total, 4 * 10_000 - Math.floor(800 * 0.1), 'seule la commission a quitté les joueurs');
  assert.deepEqual(robots.flatMap((r) => r.reponses.filter((x) => !x.ok)), []);
  robots.forEach((r) => r.fermer());
});

test('le serveur joue le tour d’un joueur absent quand le chronomètre est écoulé', { timeout: 40_000 }, async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs);
  // Le premier joueur « dort » ; seul l'autre est éveillé.
  const dormeur = await new Robot(joueurs[0], { dort: true }).connecter(url, partie);
  const eveille = await new Robot(joueurs[1], { dort: true }).connecter(url, partie);
  const t0 = Date.now();
  const e = await attendre(() => eveille.etats.find((x) => x.cause === 'minuterie'), 25_000, 50);
  const ecoule = Date.now() - t0;
  assert.ok(ecoule >= 16_500 && ecoule <= 19_500, `déclenché après ${ecoule} ms (attendu ~17,3 s)`);
  const moi = e.seats.find((s) => s.player_id === joueurs[0]);
  assert.equal(moi.missed_turns, 1, 'un tour manqué compté');
  console.log(`  tour automatique déclenché ${ecoule} ms après le début du tour`);
  dormeur.fermer();
  eveille.fermer();
});

test('un coup joué ailleurs (ancienne version du jeu) est relayé en moins d’une seconde', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs);
  const robot = await new Robot(joueurs[1], { dort: true }).connecter(url, partie);
  const avant = robot.etats.length;
  // Joueur 1 lance directement dans la base, comme le fait le jeu actuel.
  await bd.su.query('begin');
  await bd.su.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: joueurs[0] })]);
  await bd.su.query('select public.roll_dice($1)', [partie]);
  await bd.su.query('commit');
  const t0 = Date.now();
  const e = await attendre(() => robot.etats.slice(avant).find((x) => x.cause === 'externe' && x.game.rolled_at), 3000);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(e.game.last_dice >= 1 && e.game.last_dice <= 6);
  robot.fermer();
});

test('sécurité : jeton faux, joueur étranger, coup hors tour', async () => {
  const joueurs = await creerJoueurs(bd.su, 3);
  const partie = await creerPartie(bd.su, joueurs.slice(0, 2));

  const WebSocket = (await import('ws')).default;
  const refusJeton = await new Promise((ok) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'bonjour', jeton: 'n-importe-quoi', partie })));
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'refus') ok(m.raison); });
  });
  assert.equal(refusJeton, 'jeton');

  const etranger = await new Robot(joueurs[2]).connecter(url, partie);
  assert.equal(etranger.refus, 'pas_a_la_table');

  const deuxieme = await new Robot(joueurs[1], { dort: true }).connecter(url, partie);
  deuxieme.envoyer({ t: 'lancer', n: 1 });
  await attendre(() => deuxieme.reponses.length);
  assert.equal(deuxieme.reponses[0].ok, false);
  assert.equal(deuxieme.reponses[0].erreur, 'not_your_turn');

  deuxieme.envoyer({ t: 'jouer', pion: 9, n: 2 });
  await attendre(() => deuxieme.reponses.length >= 2);
  assert.equal(deuxieme.reponses[1].erreur, 'bad_index');
  deuxieme.fermer();
});

test('droits : le rôle serveur_jeu ne lit pas les tables, les joueurs n’ont pas accès aux fonctions internes', async () => {
  const c = new pg.Client({ connectionString: bd.urlServeur });
  await c.connect();
  await assert.rejects(c.query('select * from games limit 1'), /permission denied/);
  await assert.rejects(c.query('select * from profiles limit 1'), /permission denied/);
  await assert.rejects(c.query(`select public._start_game(gen_random_uuid())`), /permission denied/);
  await c.end();

  for (const role of ['anon', 'authenticated']) {
    await bd.su.query('begin');
    await bd.su.query(`set local role ${role}`);
    await assert.rejects(bd.su.query(`select public._serveur_action(gen_random_uuid(), gen_random_uuid(), 'lancer')`), /permission denied/);
    await bd.su.query('rollback');
    await bd.su.query('begin');
    await bd.su.query(`set local role ${role}`);
    await assert.rejects(bd.su.query(`select public._serveur_etat(null, true)`), /permission denied/);
    await bd.su.query('rollback');
  }
});

test('calcul de l’échéance du chronomètre', () => {
  const t = Date.parse('2026-09-30T10:00:00Z');
  const base = { status: 'playing', turn_started_at: new Date(t).toISOString() };
  assert.equal(echeance({ ...base, must_move: false }), t + 17_000);
  assert.equal(echeance({ ...base, must_move: true, rolled_at: new Date(t + 15_000).toISOString(), auto_rolled: false }), t + 24_000);
  assert.equal(echeance({ ...base, must_move: true, rolled_at: new Date(t + 17_000).toISOString(), auto_rolled: true }), t + 19_000);
  assert.equal(echeance({ ...base, status: 'finished' }), null);
});

test('jeton : la vérification Supabase refuse un jeton invalide sans appeler le réseau', async () => {
  const { verificateurSupabase } = await import('../src/jetons.js');
  const v = verificateurSupabase('https://exemple.invalid', 'cle');
  assert.equal(await v('court'), null);
  assert.equal(await v(null), null);
  assert.equal(jetonDe('x'), 'jeton-de-test-x');
});

test('charge : 20 parties rapides en même temps (40 téléphones)', { timeout: 300_000 }, async () => {
  const lots = await Promise.all(Array.from({ length: 20 }, async () => {
    const joueurs = await creerJoueurs(bd.su, 2);
    const partie = await creerPartie(bd.su, joueurs, { mise: 100, mode: 'fast' });
    return { joueurs, partie };
  }));
  const t0 = Date.now();
  const robots = (await Promise.all(lots.map(({ joueurs, partie }) =>
    Promise.all(joueurs.map((j) => new Robot(j).connecter(url, partie)))))).flat();
  await attendre(() => robots.every((r) => r.etat?.game.status === 'finished'), 280_000, 100);
  const coups = robots.reduce((a, r) => a + r.reponses.length, 0);
  assert.deepEqual(robots.flatMap((r) => r.reponses.filter((x) => !x.ok)), []);
  const lat = robots.flatMap((r) => r.latences).sort((a, b) => a - b);
  console.log(`  20 parties terminées en ${Math.round((Date.now() - t0) / 1000)} s, ${coups} coups, latence médiane ${lat[lat.length >> 1]} ms, 99e centile ${lat[Math.floor(lat.length * 0.99)]} ms`);
  const { rows } = await bd.su.query(`select count(*)::int n from transactions where type = 'gain' and game_id = any($1)`, [lots.map((l) => l.partie)]);
  assert.equal(rows[0].n, 20, 'chaque partie a payé exactement un gagnant');
  robots.forEach((r) => r.fermer());
});
