import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import WebSocket from 'ws';
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

test('sticker : payé par la base puis montré tout de suite à toute la table', async () => {
  const joueurs = await creerJoueurs(bd.su, 3);
  const partie = await creerPartie(bd.su, joueurs, { mise: 100 });
  const robots = await Promise.all(joueurs.map((j) => new Robot(j, { dort: true }).connecter(url, partie)));
  const recus = robots.map(() => []);
  robots.forEach((r, i) => r.ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'emoji') recus[i].push(m); }));
  const t0 = Date.now();
  robots[0].envoyer({ t: 'emoji', emoji: '💣', cible: joueurs[1], n: 50 });
  await attendre(() => recus.every((l) => l.length === 1), 3000);
  const ecoule = Date.now() - t0;
  const rep = await attendre(() => robots[0].reponses.find((x) => x.n === 50));
  assert.equal(rep.ok, true);
  for (const l of recus) {
    assert.equal(l[0].ligne.emoji, '💣');
    assert.equal(l[0].ligne.de, joueurs[0]);
    assert.equal(l[0].ligne.a, joueurs[1]);
  }
  const { rows } = await bd.su.query('select balance from profiles where id = $1', [joueurs[0]]);
  assert.equal(rows[0].balance, 10_000 - 100 - 10, 'mise + prix du sticker');
  // délai de 3 s de la base toujours respecté
  robots[0].envoyer({ t: 'emoji', emoji: '👍', cible: joueurs[2], n: 51 });
  const rep2 = await attendre(() => robots[0].reponses.find((x) => x.n === 51));
  assert.equal(rep2.ok, false);
  assert.equal(rep2.erreur, 'trop_rapide');
  // sticker inconnu refusé
  await new Promise((r) => setTimeout(r, 3100));
  robots[0].envoyer({ t: 'emoji', emoji: '🦄', cible: joueurs[2], n: 52 });
  const rep3 = await attendre(() => robots[0].reponses.find((x) => x.n === 52));
  assert.equal(rep3.erreur, 'emoji_inconnu');
  console.log(`  sticker vu par les 3 téléphones en ${ecoule} ms`);
  robots.forEach((r) => r.fermer());
});

test('présence : chacun sait qui est connecté à la table', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  const partie = await creerPartie(bd.su, joueurs);
  const presences = [];
  const a = await new Robot(joueurs[0], { dort: true }).connecter(url, partie);
  a.ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'presence') presences.push(m.connectes); });
  const b = await new Robot(joueurs[1], { dort: true }).connecter(url, partie);
  await attendre(() => presences.some((l) => l.length === 2), 2000);
  b.fermer();
  await attendre(() => presences.at(-1)?.length === 1 && presences.at(-1)[0] === joueurs[0], 2000);
  a.fermer();
});

test('salle d’attente et revanche : un changement fait par Supabase est annoncé tout de suite', async () => {
  const joueurs = await creerJoueurs(bd.su, 2);
  // salle d'attente : l'hôte attend, l'autre joueur rejoint
  const { rows } = await bd.su.query(`insert into games (code, host_id, mise, max_players, mode) values ('SALLE1', $1, 100, 2, 'fast') returning id`, [joueurs[0]]);
  const salle = rows[0].id;
  await bd.su.query(`insert into game_players (game_id, player_id, color, play_order) values ($1, $2, 'yellow', 1)`, [salle, joueurs[0]]);
  const hote = await new Robot(joueurs[0], { dort: true }).connecter(url, salle);
  await bd.su.query(`insert into game_players (game_id, player_id, color, play_order) values ($1, $2, 'blue', 2)`, [salle, joueurs[1]]);
  const t0 = Date.now();
  const invite = await new Robot(joueurs[1], { dort: true }).connecter(url, salle);   // son arrivée déclenche l'annonce
  await attendre(() => hote.etat?.seats?.length === 2, 2000);
  console.log(`  arrivée dans la salle vue par l'hôte en ${Date.now() - t0} ms`);

  // revanche : partie terminée, l'un propose une revanche par Supabase
  await bd.su.query(`update games set status = 'finished' where id = $1`, [salle]);
  invite.envoyer({ t: 'actualiser' });
  await attendre(() => hote.etat?.game?.status === 'finished', 2000);
  const { rows: r2 } = await bd.su.query(`insert into games (code, host_id, mise, max_players, mode, rematch_of) values ('REV001', $1, 100, 2, 'fast', $2) returning id`, [joueurs[1], salle]);
  await bd.su.query(`insert into game_players (game_id, player_id, color, play_order) values ($1, $2, 'yellow', 1)`, [r2[0].id, joueurs[1]]);
  const t1 = Date.now();
  invite.envoyer({ t: 'actualiser' });
  const e = await attendre(() => hote.etat?.revanche?.id === r2[0].id && hote.etat, 2000);
  assert.equal(e.revanche.status, 'waiting');
  assert.deepEqual(e.revanche.game_players, [{ player_id: joueurs[1] }]);
  console.log(`  revanche vue par l'autre joueur en ${Date.now() - t1} ms`);
  hote.fermer(); invite.fermer();
});

// ------------------------------------------------------- ligne directe ----
// Un téléphone hors partie : il ouvre sa session et note les signaux reçus.
function ouvrirSession(uid, jeton = jetonDe(uid)) {
  return new Promise((ok, ko) => {
    const ws = new WebSocket(url);
    const s = { ws, uid, signaux: [], refus: null, enLigne: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'session', jeton })));
    ws.on('error', ko);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'session_ok') ok(s);
      if (m.t === 'refus') { s.refus = m.raison; ok(s); }
      if (m.t === 'signaux') s.signaux.push(...m.liste);
      if (m.t === 'en_ligne') s.enLigne = m.ids;
    });
  });
}
const aRecu = (s, sujet, cle) => s.signaux.some(([x, c]) => x === sujet && (cle === undefined || c === cle));

test('ligne directe : jeton faux refusé', async () => {
  const s = await ouvrirSession('x', 'faux');
  assert.equal(s.refus, 'jeton');
});

test('ligne directe : chaque joueur ne reçoit que ses propres signaux, en moins de 2 s', async () => {
  const [a, b] = await creerJoueurs(bd.su, 2);
  const sa = await ouvrirSession(a);
  const sb = await ouvrirSession(b);
  const t0 = Date.now();
  await bd.su.query(`insert into transactions (player_id, type, amount, balance_after) values ($1, 'gain', 100, 10100)`, [a]);
  await attendre(() => aRecu(sa, 'solde'), 3000);
  console.log(`  signal « solde » reçu en ${Date.now() - t0} ms`);
  await bd.su.query(`insert into notifications (user_id, type) values ($1, 'test')`, [a]);
  await bd.su.query(`insert into payment_requests (user_id, kind, amount, operator, phone) values ($1, 'deposit', 500, 'mtn', '677000000')`, [a]);
  await bd.su.query(`insert into support_chat (user_id, sender, body) values ($1, 'admin', 'bonjour')`, [a]);
  await attendre(() => aRecu(sa, 'notifications') && aRecu(sa, 'paiements') && aRecu(sa, 'support'), 3000);
  // une demande d'ami prévient les deux
  await bd.su.query(`insert into friendships (requester_id, addressee_id) values ($1, $2)`, [a, b]);
  await attendre(() => aRecu(sa, 'amis') && aRecu(sb, 'amis'), 3000);
  assert.ok(!aRecu(sb, 'solde') && !aRecu(sb, 'notifications') && !aRecu(sb, 'paiements') && !aRecu(sb, 'support'),
    'B ne doit rien recevoir de ce qui concerne A');
  sa.ws.close(); sb.ws.close();
});

test('ligne directe : salon pour tous, partie pour les joueurs assis, rien à chaque coup', async () => {
  const [a, b, c] = await creerJoueurs(bd.su, 3);
  const [sa, sb, sc] = await Promise.all([ouvrirSession(a), ouvrirSession(b), ouvrirSession(c)]);
  const { rows } = await bd.su.query(`insert into games (code, host_id, mise, max_players, mode) values ('SIG001', $1, 100, 2, 'fast') returning id`, [a]);
  const g = rows[0].id;
  await bd.su.query(`insert into game_players (game_id, player_id, color, play_order) values ($1, $2, 'yellow', 1)`, [g, a]);
  await attendre(() => aRecu(sa, 'salon') && aRecu(sb, 'salon') && aRecu(sc, 'salon'), 3000);
  await bd.su.query(`insert into game_players (game_id, player_id, color, play_order) values ($1, $2, 'blue', 2)`, [g, b]);
  await attendre(() => aRecu(sa, 'partie', g) && aRecu(sb, 'partie', g), 3000);
  assert.ok(!aRecu(sc, 'partie', g), 'C n’est pas assis : pas de signal « partie »');

  // Une fois lancée, un coup (mise à jour de la partie) n'écrit AUCUN signal.
  await bd.su.query(`update games set status = 'playing' where id = $1`, [g]);
  const { rows: [{ n: avant }] } = await bd.su.query('select count(*)::int as n from evenements_serveur');
  await bd.su.query(`update games set current_turn = $2, last_dice = 4, must_move = true where id = $1`, [g, a]);
  await bd.su.query(`update game_players set pawns = '{0,-1,-1,-1}' where game_id = $1 and player_id = $2`, [g, a]);
  const { rows: [{ n: apres }] } = await bd.su.query('select count(*)::int as n from evenements_serveur');
  assert.equal(apres, avant, 'un coup ne doit pas écrire de signal');
  sa.ws.close(); sb.ws.close(); sc.ws.close();
});

test('ligne directe : « qui est en ligne ? » ne répond que pour les sessions ouvertes', async () => {
  const [a, b, c] = await creerJoueurs(bd.su, 3);
  const sa = await ouvrirSession(a);
  const sb = await ouvrirSession(b);
  sa.ws.send(JSON.stringify({ t: 'en_ligne', ids: [a, b, c] }));
  await attendre(() => sa.enLigne, 2000);
  assert.deepEqual(new Set(sa.enLigne), new Set([a, b]));
  sb.ws.close();
  await attendre(() => !serveur.sessions.has(b), 2000);
  sa.enLigne = null;
  sa.ws.send(JSON.stringify({ t: 'en_ligne', ids: [a, b, c] }));
  await attendre(() => sa.enLigne, 2000);
  assert.deepEqual(sa.enLigne, [a]);
  sa.ws.close();
});

test('sûreté : un journal de signaux en panne ne bloque jamais une transaction', async () => {
  const [a] = await creerJoueurs(bd.su, 1);
  await bd.su.query('alter table evenements_serveur rename to evenements_serveur_hs');
  try {
    await bd.su.query(`insert into transactions (player_id, type, amount, balance_after) values ($1, 'gain', 50, 10050)`, [a]);
    await bd.su.query(`insert into notifications (user_id, type) values ($1, 'test')`, [a]);
    const { rows } = await bd.su.query(`select count(*)::int as n from transactions where player_id = $1`, [a]);
    assert.equal(rows[0].n, 1);
  } finally {
    await bd.su.query('alter table evenements_serveur_hs rename to evenements_serveur');
  }
});

test('droits : le rôle serveur_jeu lit les signaux par la fonction, jamais la table', async () => {
  const c = new pg.Client({ connectionString: bd.urlServeur });
  await c.connect();
  try {
    const r = await c.query('select public._serveur_evenements(null) as e');
    assert.ok(typeof r.rows[0].e.dernier === 'number');
    await assert.rejects(c.query('select * from evenements_serveur'), /permission denied/);
  } finally {
    await c.end();
  }
});
