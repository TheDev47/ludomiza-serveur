// Outils de test : base locale jetable, joueurs, parties et robots.
//
// Prérequis : un Postgres 17 local (voir test/LISEZ-MOI.md).
// Adresse : PG_TEST_URL (par défaut postgres://postgres@127.0.0.1:54329/postgres)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { appliquer } from '../src/delta.js';

const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADMIN_URL = process.env.PG_TEST_URL || 'postgres://postgres@127.0.0.1:54329/postgres';

export async function creerBaseDeTest() {
  const nom = `ludotest_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${nom}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${nom}`);
  const su = new pg.Client({ connectionString: url });
  await su.connect();
  await su.query(fs.readFileSync(path.join(RACINE, 'test/sql/00_base_locale.sql'), 'utf8'));
  for (const f of fs.readdirSync(path.join(RACINE, 'sql')).filter((x) => x.endsWith('.sql')).sort()) {
    await su.query(fs.readFileSync(path.join(RACINE, 'sql', f), 'utf8'));
  }
  // En local seulement : le rôle du serveur peut se connecter (en production,
  // c'est Jordan qui lui donne un mot de passe, dans Supabase).
  await su.query(`alter role serveur_jeu login password 'test'`);

  const urlServeur = url.replace('postgres@', 'serveur_jeu:test@');

  return {
    url,
    urlServeur,
    su,
    async detruire() {
      await su.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${nom} with (force)`);
      await a.end();
    },
  };
}

export async function creerJoueurs(su, n, solde = 10_000) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    await su.query('insert into profiles (id, pseudo, balance) values ($1, $2, $3)', [id, `robot${i + 1}`, solde]);
    ids.push(id);
  }
  return ids;
}

// Partie démarrée par les vraies fonctions (_start_game prend les mises).
export async function creerPartie(su, joueurs, { mise = 500, mode = 'fast' } = {}) {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const { rows } = await su.query(
    `insert into games (code, host_id, mise, max_players, mode) values ($1, $2, $3, $4, $5) returning id`,
    [code, joueurs[0], mise, joueurs.length, mode],
  );
  const id = rows[0].id;
  const couleurs = ['yellow', 'blue', 'red', 'green'];
  for (let i = 0; i < joueurs.length; i++) {
    await su.query('insert into game_players (game_id, player_id, color, play_order) values ($1, $2, $3, $4)',
      [id, joueurs[i], couleurs[i], i + 1]);
  }
  const r = await su.query('select public._start_game($1) as r', [id]);
  if (!r.rows[0].r.ok) throw new Error(`démarrage refusé : ${r.rows[0].r.error}`);
  // _start_game laisse 5 s avant le premier lancer : inutile en test.
  await su.query('update games set turn_started_at = now() where id = $1', [id]);
  return id;
}

export const jetonDe = (uid) => `jeton-de-test-${uid}`;
export async function verifierJetonDeTest(jeton) {
  const m = /^jeton-de-test-(.+)$/.exec(jeton ?? '');
  return m ? m[1] : null;
}

// ------------------------------------------------------------- robot ----
// Un « téléphone » automatique : il lance quand c'est son tour et joue
// un pion permis au hasard. « dort » = ne joue jamais (pour les chronomètres).
export class Robot {
  constructor(uid, { dort = false, proto = 1, depuis = null, compression = true } = {}) {
    this.compression = compression;
    this.uid = uid;
    this.dort = dort;
    this.proto = proto;          // 2 : reçoit les différences (« maj ») et les applique
    this.depuis = depuis;        // { ep, v } : reprise après coupure
    this.octets = 0;
    this.maj = 0;
    this.complets = 0;
    this.reprisesDemandees = 0;
    this.etat = null;
    this.etats = [];
    this.reponses = [];
    this.n = 0;
    this.attente = false;
    this.refus = null;
    this.latences = [];
    this.envois = new Map();
  }

  connecter(url, partie) {
    this.partie = partie;
    return new Promise((ok, ko) => {
      const ws = new WebSocket(url, { perMessageDeflate: this.compression });
      this.ws = ws;
      ws.on('open', () => ws.send(JSON.stringify({
        t: 'bonjour', jeton: jetonDe(this.uid), partie,
        ...(this.proto >= 2 ? { proto: 2, ...(this.depuis || {}) } : {}),
      })));
      ws.on('error', ko);
      ws.on('message', (d) => {
        this.octets += d.length;
        const m = JSON.parse(d.toString());
        if (m.t === 'bienvenue') { this.bienvenue = m; ok(this); }
        if (m.t === 'refus') { this.refus = m.raison; ok(this); }
        if (m.t === 'etat') { this.complets++; this.local = { ep: m.ep, v: m.v, game: m.game, seats: m.seats, revanche: m.revanche }; this.recevoirEtat(m); }
        if (m.t === 'maj') {
          this.maj++;
          const l = this.local;
          if (!l || l.ep !== m.ep || l.v !== m.de) {
            this.reprisesDemandees++;
            this.envoyer({ t: 'reprendre' });
            return;
          }
          const e = appliquer(l, m.d);
          this.local = { ep: m.ep, v: m.v, ...e };
          this.recevoirEtat({ ...m, t: 'etat', game: e.game, seats: e.seats, revanche: e.revanche });
        }
        if (m.t === 'reponse') {
          this.reponses.push(m);
          this.attente = false;
          this.agir();
        }
      });
    });
  }

  envoyer(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  recevoirEtat(m) {
    this.etat = m;
    this.etats.push({ ...m, recuA: Date.now() });
    // latence vue par l'adversaire : de l'envoi d'une action à sa réception ici
    if (m.par && m.par !== this.uid && Robot.envois.has(m.par)) {
      this.latences.push(Date.now() - Robot.envois.get(m.par));
    }
    this.agir();
  }

  // Petit temps de « réflexion » (40 ms) : un robot plus rapide qu'un humain
  // dépasserait la limite de messages par seconde du serveur.
  agir() {
    if (this.dort || this.attente || this.prevu) return;
    this.prevu = setTimeout(() => { this.prevu = null; this.agirMaintenant(); }, 40);
  }

  agirMaintenant() {
    if (this.dort || this.attente || !this.etat || this.ws.readyState !== 1) return;
    const g = this.etat.game;
    if (g.status !== 'playing' || g.current_turn !== this.uid) return;
    if (!g.must_move) {
      this.attente = true;
      Robot.envois.set(this.uid, Date.now());
      this.envoyer({ t: 'lancer', n: ++this.n });
      return;
    }
    if (g.dice_owner !== this.uid) return;
    const moi = this.etat.seats.find((s) => s.player_id === this.uid);
    const d = g.last_dice;
    const permis = [];
    moi.pawns.forEach((p, i) => {
      if (p === -1 ? d === 6 : p < 56 && p + d <= 56) permis.push(i + 1);
    });
    if (!permis.length) return;
    this.attente = true;
    Robot.envois.set(this.uid, Date.now());
    this.envoyer({ t: 'jouer', pion: permis[Math.floor(Math.random() * permis.length)], n: ++this.n });
  }

  /** Octets réellement reçus sur le réseau (après compression). */
  octetsReseau() { return this.ws?._socket?.bytesRead ?? 0; }

  fermer() {
    clearTimeout(this.prevu);
    this.dort = true;
    this.ws?.close();
  }
}
Robot.envois = new Map();

export function attendre(condition, delaiMs = 10_000, pasMs = 20) {
  return new Promise((ok, ko) => {
    const debut = Date.now();
    const iv = setInterval(async () => {
      let v;
      try { v = await condition(); } catch (e) { clearInterval(iv); ko(e); return; }
      if (v) { clearInterval(iv); ok(v); }
      else if (Date.now() - debut > delaiMs) { clearInterval(iv); ko(new Error('délai dépassé')); }
    }, pasMs);
  });
}
