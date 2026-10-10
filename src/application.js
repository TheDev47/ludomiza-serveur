// Serveur de jeu LudoMiza.
//
// Rôle : « messager rapide » entre les téléphones et Supabase (lancers, coups,
// abandons, stickers).
//   - chaque téléphone garde UNE connexion ouverte (WebSocket) pendant la partie ;
//   - « je lance » / « je joue le pion 3 » arrive ici, part à la base en un seul
//     appel (les règles restent dans Supabase), et l'état à jour est renvoyé
//     aussitôt à TOUS les joueurs de la table ;
//   - le serveur déclenche lui-même les tours automatiques (chronomètre écoulé)
//     à la seconde près, au lieu d'attendre qu'un téléphone le fasse ;
//   - un coup d'œil régulier à la base rattrape tout ce qui se passe ailleurs
//     (abandon depuis l'ancienne version, régie, nettoyage automatique…).
//
// Aucune règle du Ludo n'est recopiée ici, et aucun solde n'est touché.
//
// Depuis 0.4.0, chaque téléphone peut aussi ouvrir une « ligne directe »
// (message « session ») pour toute la durée de l'appli : le serveur lit une
// fois par seconde le journal des signaux de la base (_serveur_evenements) et
// prévient chaque joueur de ce qu'il doit relire (solde, notifications, amis,
// paiements, support, salon, tournoi, partie). Aucune donnée ne transite : un
// signal dit seulement « relis ceci ». L'appli n'a alors plus besoin du temps
// réel de Supabase, limité en formule gratuite.

import { verifierMessage, LONGUEUR_MAX } from './moderation.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { difference } from './delta.js';

export const VERSION = '0.12.0';

// Depuis 0.5.0 (protocole 2, annoncé par le téléphone dans « bonjour ») :
//   - chaque état porte un numéro de version « v » et l'« époque » du serveur
//     (« ep », tirée au démarrage : les numéros repartent de zéro après un
//     redémarrage) ;
//   - après un coup, le serveur n'envoie que la DIFFÉRENCE (message « maj ») ;
//   - à la reconnexion, le téléphone donne sa dernière version : il ne reçoit
//     que ce qui a changé depuis, et l'état complet seulement si c'est trop vieux ;
//   - tous les messages sont compressés (permessage-deflate).
// Les anciennes versions du jeu continuent de recevoir l'état complet (« etat »).
export const PROTOCOLE = 2;
const HISTORIQUE = 40;   // états gardés par partie, pour la reprise après coupure

// Délais appliqués par la base (force_turn / force_move). Le serveur déclenche
// l'action automatique juste après ; la base revérifie de toute façon.
// Depuis le 03/10/2026, le délai du tour est dans la partie (games.delai_tour_s :
// 16 s, ou 6 s pour un joueur absent 2 tours d'affilée) ; les valeurs ci-dessous
// ne servent que si la base ne le donne pas.
export const DELAIS_MS = {
  lancer: 17_000, // force_turn : délai du tour après son début
  pion: 19_000, // force_move : délai du tour + 2 s après son début…
  apresLancer: 7_000, // …et 7 s après un lancer manuel
  apresLancerAuto: 2_000, // …ou 2 s après un lancer automatique
};

// Réaction de spectateur : un code court (la liste des messages est dans l'appli).
const CODE_REACTION = /^[a-z0-9_]{1,24}$/;
const REACTION_MIN_MS = 2500;      // une réaction toutes les 2,5 s par spectateur
const REACTIONS_PAR_PARTIE_S = 12; // au plus 12 par seconde pour toute la table
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Instant (horloge de la base, en ms) à partir duquel l'action automatique est permise.
export function echeance(game) {
  if (!game || game.status !== 'playing') return null;
  const debutTour = game.turn_started_at ? Date.parse(game.turn_started_at) : null;
  const delai = Number.isFinite(game.delai_tour_s) ? game.delai_tour_s * 1000 : null;
  const lancer = delai ?? DELAIS_MS.lancer;
  const pion = delai != null ? delai + 2000 : DELAIS_MS.pion;
  if (!game.must_move) return debutTour == null ? 0 : debutTour + lancer;
  const lance = game.rolled_at ? Date.parse(game.rolled_at) : debutTour;
  return Math.max(
    debutTour == null ? 0 : debutTour + pion,
    (lance ?? 0) + (game.auto_rolled ? DELAIS_MS.apresLancerAuto : DELAIS_MS.apresLancer),
  );
}

export function creerServeur({
  base,
  verifierJeton,
  port = 8080,
  hote = '0.0.0.0',
  origines = [], // vide = toutes acceptées
  sondageMs = 1000,
  margeMs = 250,
  toutesLesParties = false, // chronomètres aussi pour les parties sans téléphone connecté ici
  maxMessagesParSeconde = 30,
  signauxMs = 1000,
  presenceMs = 30_000,
  journal = console,
} = {}) {
  // Temps d'aller-retour serveur ↔ téléphone (ping du battement), 500 dernières mesures.
  const rtts = [];
  function noterRtt(ms) { rtts.push(ms); if (rtts.length > 500) rtts.shift(); }
  // Aller-retour serveur ↔ base (lecture des signaux, chaque seconde), 300 dernières mesures.
  const rttsBase = [];
  function noterRttBase(ms) { rttsBase.push(ms); if (rttsBase.length > 300) rttsBase.shift(); }
  function centile(liste, q) {
    if (!liste.length) return null;
    const t = [...liste].sort((a, b) => a - b);
    return t[Math.min(t.length - 1, Math.floor(q * t.length))];
  }

  const parties = new Map();
  const EPOQUE = crypto.randomBytes(4).toString('hex');
  const stats = { demarre: new Date().toISOString(), actions: 0, forces: 0, stickers: 0, erreursBase: 0, msBaseTotal: 0, signaux: 0, octetsEtat: 0, octetsMaj: 0, reprises: 0, reprisesCompletes: 0 };

  // ------------------------------------------------- sessions (ligne directe) ----
  const sessions = new Map();   // joueur -> Set(ws)
  function ouvrirSession(ws, uid) {
    if (ws.session && ws.session !== uid) fermerSession(ws);
    ws.session = uid;
    if (ws.visible === undefined) ws.visible = true;
    let s = sessions.get(uid);
    if (!s) { s = new Set(); sessions.set(uid, s); }
    s.add(ws);
  }
  function fermerSession(ws) {
    const s = ws.session && sessions.get(ws.session);
    if (s) { s.delete(ws); if (!s.size) sessions.delete(ws.session); }
    ws.session = null;
  }

  // Présence (0.10.0) : « vu il y a… » et « présent en salle d'attente »,
  // notés en UNE requête pour tous les joueurs qui ont l'appli ouverte et à
  // l'écran. Les téléphones n'ont plus à appeler noter_vu / salle_present.
  let presenceEnPauseJusqua = 0;
  async function noterPresence() {
    if (Date.now() < presenceEnPauseJusqua || sessions.size === 0) return;
    const ids = [];
    for (const [uid, set] of sessions) {
      for (const w of set) { if (w.visible !== false) { ids.push(uid); break; } }
    }
    if (!ids.length) return;
    try {
      await base.presence(ids);
      stats.presences = (stats.presences || 0) + 1;
    } catch (e) {
      stats.erreursBase++;
      presenceEnPauseJusqua = Date.now() + 5 * 60_000;   // ex. SQL pas encore installé : on réessaie plus tard
      journal.error('[présence]', e?.message ?? e);
    }
  }

  // Journal des signaux : curseur + numéros déjà vus (la base relit une courte
  // fenêtre, car deux transactions peuvent valider dans le désordre).
  let curseur = null;
  const vus = new Map();        // id -> instant où il a été vu
  let signauxEnCours = false;
  let signauxEnPauseJusqua = 0;   // après une erreur (ex. SQL pas encore installé) : 30 s de pause
  async function lireSignaux() {
    if (signauxEnCours || Date.now() < signauxEnPauseJusqua) return;
    signauxEnCours = true;
    try {
      if (curseur == null) {
        const r = await base.evenements(null);
        curseur = Number(r.dernier) || 0;
        return;
      }
      if (sessions.size === 0) {
        // Personne à prévenir : on avance le curseur sans rien envoyer.
        const r = await base.evenements(null);
        curseur = Math.max(curseur, Number(r.dernier) || 0);
        return;
      }
      const t0 = performance.now();
      const r = await base.evenements(curseur);
      noterRttBase(Math.round(performance.now() - t0));
      const maintenant = Date.now();
      const parWs = new Map();  // ws -> Map("sujet|cle" -> [sujet, cle])
      const ajouter = (ws, sujet, cle) => {
        let m = parWs.get(ws);
        if (!m) { m = new Map(); parWs.set(ws, m); }
        m.set(`${sujet}|${cle ?? ''}`, cle == null ? [sujet] : [sujet, cle]);
      };
      for (const [id, uid, sujet, cle] of r.evts || []) {
        if (vus.has(id)) continue;
        vus.set(id, maintenant);
        if (uid == null) {
          for (const set of sessions.values()) for (const ws of set) ajouter(ws, sujet, cle);
        } else {
          for (const ws of sessions.get(uid) || []) ajouter(ws, sujet, cle);
        }
      }
      for (const [ws, m] of parWs) {
        stats.signaux += m.size;
        envoyer(ws, { t: 'signaux', liste: [...m.values()] });
      }
      curseur = Math.max(curseur, Number(r.dernier) || curseur);
      for (const [id, t] of vus) if (maintenant - t > 60_000) vus.delete(id);
    } catch (e) {
      stats.erreursBase++;
      journal.error('[signaux]', e.message);
      signauxEnPauseJusqua = Date.now() + 30_000;
    } finally {
      signauxEnCours = false;
    }
  }

  // ------------------------------------------------------------- parties ----
  function obtenir(id) {
    let p = parties.get(id);
    if (!p) {
      p = { id, etat: null, sig: '', version: 0, clients: new Set(), file: Promise.resolve(),
            occupe: 0, minuterie: null, decalage: 0, essaisForce: 0,
            historique: [], delta: null,   // historique : [{ v, etat }] ; delta : dernière différence
            chat: [], memoiresChat: new Map() };   // chat : 50 derniers messages ; mémoire anti-numéro par joueur
      parties.set(id, p);
    }
    return p;
  }

  // Les actions d'une même partie passent l'une après l'autre (la base
  // verrouille aussi la ligne, mais on évite ainsi les états croisés).
  function enFile(p, fn) {
    p.occupe++;
    const suite = p.file.then(fn).catch((e) => journal.error(`[partie ${p.id}]`, e?.message ?? e))
      .finally(() => { p.occupe--; });
    p.file = suite;
    return suite;
  }

  function envoyer(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function diffuser(p, msg) {
    const txt = JSON.stringify(msg);
    for (const ws of p.clients) if (ws.readyState === 1) ws.send(txt);
  }

  function messageEtat(p, cause, extra = {}) {
    return { t: 'etat', partie: p.id, game: p.etat.game, seats: p.etat.seats, revanche: p.etat.revanche ?? null,
             v: p.version, ep: EPOQUE, cause, ...extra, s: Date.now() };
  }

  // Protocole 2 : seulement ce qui a changé depuis la version « de ».
  function messageMaj(p, de, d, cause, extra = {}) {
    return { t: 'maj', partie: p.id, ep: EPOQUE, de, v: p.version, d, cause, ...extra, s: Date.now() };
  }

  // Nouvel état à toute la table : la différence aux téléphones récents,
  // l'état complet aux anciennes versions du jeu.
  function diffuserEtat(p, cause, extra) {
    let complet = null;
    let maj = null;
    for (const ws of p.clients) {
      if (ws.readyState !== 1) continue;
      if (ws.proto >= 2 && p.delta) {
        maj ??= JSON.stringify(messageMaj(p, p.delta.de, p.delta.d, cause, extra));
        ws.send(maj);
        stats.octetsMaj += maj.length;
      } else {
        complet ??= JSON.stringify(messageEtat(p, cause, extra));
        ws.send(complet);
        stats.octetsEtat += complet.length;
      }
    }
  }

  // Un téléphone (re)vient : s'il connaît une version récente de cette partie,
  // il ne reçoit que la différence ; sinon l'état complet.
  function envoyerEtatA(ws, p, cause, depuis) {
    if (ws.proto >= 2 && depuis && depuis.ep === EPOQUE && Number.isInteger(depuis.v)) {
      const connu = depuis.v === p.version ? p.etat : p.historique.find((h) => h.v === depuis.v)?.etat;
      if (connu) {
        stats.reprises++;
        envoyer(ws, messageMaj(p, depuis.v, depuis.v === p.version ? {} : difference(connu, p.etat), cause));
        return;
      }
      stats.reprisesCompletes++;
    }
    envoyer(ws, messageEtat(p, cause));
  }

  // Présence : qui, à cette table, a une connexion ouverte avec le serveur.
  // Envoyé à chaque arrivée ou départ ; le téléphone attend quelques secondes
  // avant d'afficher « hors ligne » (une reconnexion rapide ne se voit pas).
  function connectes(p) {
    return [...new Set([...p.clients].filter((w) => w.readyState === 1 && w.uid && !w.spectateur).map((w) => w.uid))];
  }
  // Spectateurs : nombre de personnes (pas de connexions) qui regardent la table.
  function nbSpectateurs(p) {
    return new Set([...p.clients].filter((w) => w.readyState === 1 && w.uid && w.spectateur).map((w) => w.uid)).size;
  }
  function diffuserPresence(p) {
    diffuser(p, { t: 'presence', partie: p.id, connectes: connectes(p), spectateurs: nbSpectateurs(p) });
  }

  // Réaction d'un spectateur (message tout prêt) : relayée à toute la table,
  // rien n'est écrit dans la base.
  function relayerReaction(ws, m) {
    const p = ws.partie;
    if (!p || !ws.spectateur) return;
    if (typeof m.code !== 'string' || !CODE_REACTION.test(m.code)) return;
    const t = Date.now();
    if (ws.derniereReaction && t - ws.derniereReaction < REACTION_MIN_MS) return;
    if (t - (p.fenetreReactions || 0) >= 1000) { p.fenetreReactions = t; p.nbReactions = 0; }
    // Cible facultative : un joueur assis à cette table.
    const cible = typeof m.cible === 'string' && p.etat?.seats?.some((x) => x.player_id === m.cible) ? m.cible : null;
    if (++p.nbReactions > REACTIONS_PAR_PARTIE_S) return;
    ws.derniereReaction = t;
    stats.reactions = (stats.reactions || 0) + 1;
    diffuser(p, { t: 'reaction', partie: p.id, code: m.code, de: ws.uid, pseudo: ws.pseudo || null, cible,
                  id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}` });
  }

  // ------------------------------------------------------------------ chat ----
  // Message libre d'un joueur ou d'un spectateur : vérifié (numéro, lien, insultes)
  // AVANT d'être relayé. Rien n'est écrit en base, sauf une suspension.
  const suspensions = new Map();   // uid -> { jusqua: ms|0, fin: ms (cache) }
  async function suspenduJusqua(uid) {
    const c = suspensions.get(uid);
    if (c && c.fin > Date.now()) return c.jusqua > Date.now() ? c.jusqua : 0;
    let j = 0;
    try { const d = await base.chatEtat(uid); j = d ? Date.parse(d) : 0; } catch (e) { journal.error('[chat]', e?.message ?? e); }
    if (suspensions.size > 5000) suspensions.clear();
    suspensions.set(uid, { jusqua: j, fin: Date.now() + 5 * 60_000 });
    return j;
  }
  async function relayerChat(ws, m) {
    const p = ws.partie;
    if (!p || !ws.uid) return;
    const t = Date.now();
    if (ws.dernierChat && t - ws.dernierChat < 1000) { envoyer(ws, { t: 'chat_refus', raison: 'trop_vite' }); return; }
    if (typeof m.texte !== 'string' || !m.texte.trim()) return;
    ws.dernierChat = t;
    const jusqua = await suspenduJusqua(ws.uid);
    if (jusqua) { envoyer(ws, { t: 'chat_refus', raison: 'suspendu', jusqua: new Date(jusqua).toISOString() }); return; }
    let mem = p.memoiresChat.get(ws.uid);
    if (!mem) { mem = {}; p.memoiresChat.set(ws.uid, mem); }
    const v = verifierMessage(m.texte.slice(0, LONGUEUR_MAX * 2), mem, t);
    if (!v.ok) {
      if (v.sanction === 'suspension') {
        let fin = t + 24 * 3600_000;
        try { const d = await base.chatSuspendre(ws.uid, p.id, m.texte.slice(0, 300), v.raison); if (d) fin = Date.parse(d); }
        catch (e) { journal.error('[chat]', e?.message ?? e); }
        suspensions.set(ws.uid, { jusqua: fin, fin: fin });
        stats.chatSuspensions = (stats.chatSuspensions || 0) + 1;
        envoyer(ws, { t: 'chat_refus', raison: v.raison, suspension: true, jusqua: new Date(fin).toISOString() });
      } else if (v.raison !== 'vide') {
        envoyer(ws, { t: 'chat_refus', raison: v.raison });
      }
      return;
    }
    const pseudo = ws.pseudo || (ws.pseudo = await pseudoDe(ws.uid)) || null;
    // Message adressé à un joueur assis (facultatif) : tout le monde le voit, le début s'affiche sur sa carte
    const cible = typeof m.cible === 'string' && m.cible !== ws.uid && p.etat?.seats?.some((x) => x.player_id === m.cible) ? m.cible : null;
    const msg = { t: 'chat', partie: p.id, id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  de: ws.uid, pseudo, texte: v.texte, spect: Boolean(ws.spectateur), cible, a: t };
    p.chat.push(msg);
    if (p.chat.length > 50) p.chat.shift();
    stats.chat = (stats.chat || 0) + 1;
    diffuser(p, msg);
  }

  // Régie : liste des spectateurs de chaque partie (administrateurs seulement).
  const admins = new Map();   // uid -> { ok, fin }
  async function estAdmin(uid) {
    const c = admins.get(uid);
    if (c && c.fin > Date.now()) return c.ok;
    let ok = false;
    try { ok = await base.estAdmin(uid); } catch (e) { journal.error('[admin]', e?.message ?? e); return false; }
    if (admins.size > 1000) admins.clear();
    admins.set(uid, { ok, fin: Date.now() + 5 * 60_000 });
    return ok;
  }
  function listeSpectateurs() {
    const out = {};
    for (const [id, p] of parties) {
      const vus = new Map();
      for (const w of p.clients) if (w.readyState === 1 && w.spectateur && w.uid) vus.set(w.uid, w.pseudo || null);
      if (vus.size) out[id] = [...vus].map(([uid, pseudo]) => ({ uid, pseudo }));
    }
    return out;
  }

  // Pseudo du spectateur, lu une seule fois (gardé en mémoire 30 min).
  const pseudos = new Map();
  async function pseudoDe(uid) {
    const c = pseudos.get(uid);
    if (c && c.fin > Date.now()) return c.p;
    let p = null;
    try { p = await base.pseudo(uid); } catch (e) { journal.error('[pseudo]', e?.message ?? e); }
    if (pseudos.size > 5000) pseudos.clear();
    if (p) pseudos.set(uid, { p, fin: Date.now() + 30 * 60_000 });
    return p;
  }

  // Nouvel état venu de la base : on le garde, on le diffuse s'il a changé,
  // et on recale le chronomètre.
  function recevoirEtat(p, etat, cause, extra = {}, { toujours = false, minuterie = true } = {}) {
    if (!etat?.game) return;
    if (etat.maintenant) p.decalage = Date.parse(etat.maintenant) - Date.now();
    const sig = JSON.stringify([etat.game, etat.seats, etat.revanche ?? null]);
    const change = sig !== p.sig;
    if (change) {
      const ancien = p.etat;
      const etatCourt = { game: etat.game, seats: etat.seats, revanche: etat.revanche ?? null };
      p.sig = sig;
      p.etat = etat;
      p.version++;
      p.delta = ancien ? { de: p.version - 1, d: difference(ancien, etatCourt) } : null;
      p.historique.push({ v: p.version, etat: etatCourt });
      if (p.historique.length > HISTORIQUE) p.historique.shift();
    } else if (toujours) {
      p.delta = { de: p.version, d: {} };   // rien n'a changé : différence vide
    }
    if (change || toujours) diffuserEtat(p, cause, extra);
    if (minuterie) planifier(p);
  }

  // ---------------------------------------------------------- chronomètre ----
  function planifier(p) {
    clearTimeout(p.minuterie);
    p.minuterie = null;
    if (!toutesLesParties && p.clients.size === 0) return;
    const fin = echeance(p.etat?.game);
    if (fin == null) return;
    const attente = Math.max(0, fin - p.decalage - Date.now() + margeMs);
    p.minuterie = setTimeout(() => enFile(p, () => forcer(p)), attente);
  }

  async function forcer(p) {
    const g = p.etat?.game;
    if (!g || g.status !== 'playing') return;
    const fin = echeance(g);
    if (fin != null && fin - p.decalage - Date.now() > 0) { planifier(p); return; } // l'état a changé entre-temps
    const action = g.must_move ? 'forcer_pion' : 'forcer_tour';
    const t0 = performance.now();
    let r;
    try {
      r = await base.action(null, p.id, action);
    } catch (e) {
      stats.erreursBase++;
      journal.error(`[partie ${p.id}] ${action} :`, e.message);
      p.minuterie = setTimeout(() => enFile(p, () => forcer(p)), 1000);
      return;
    }
    stats.msBaseTotal += performance.now() - t0;
    stats.forces++;
    if (r?.resultat?.error === 'too_early') {
      // Petit écart d'horloge : on réessaie dans 300 ms (20 fois au plus).
      recevoirEtat(p, r.etat, 'minuterie', {}, { minuterie: false });
      if (++p.essaisForce <= 20) {
        clearTimeout(p.minuterie);
        p.minuterie = setTimeout(() => enFile(p, () => forcer(p)), 300);
      }
      return;
    }
    p.essaisForce = 0;
    recevoirEtat(p, r?.etat, 'minuterie', { action, resultat: r?.resultat });
  }

  // ------------------------------------------------------ actions joueurs ----
  function actionJoueur(ws, action, pion, n) {
    const p = ws.partie;
    return enFile(p, async () => {
      const t0 = performance.now();
      let r;
      try {
        r = await base.action(ws.uid, p.id, action, pion);
      } catch (e) {
        stats.erreursBase++;
        journal.error(`[partie ${p.id}] ${action} :`, e.message);
        envoyer(ws, { t: 'reponse', n, ok: false, erreur: 'base_indisponible' });
        return;
      }
      const ms = Math.round(performance.now() - t0);
      stats.msBaseTotal += ms;
      stats.actions++;
      const res = r?.resultat ?? {};
      const ok = res.ok === true;
      // D'abord tout le monde reçoit le nouvel état, puis le joueur sa réponse.
      recevoirEtat(p, r?.etat, action, { par: ws.uid, resultat: res }, { toujours: ok });
      envoyer(ws, { t: 'reponse', n, ok, erreur: ok ? undefined : res.error, resultat: res, ms });
    });
  }

  // Sticker : payé et enregistré par la base (envoyer_emoji), puis montré
  // aussitôt à toute la table — plus d'attente des notifications de Supabase.
  async function envoyerSticker(ws, m) {
    const p = ws.partie;
    const valide = typeof m.emoji === 'string' && m.emoji.length > 0 && m.emoji.length <= 16
      && typeof m.cible === 'string' && UUID.test(m.cible);
    if (!valide) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'cible_invalide' }); return; }
    const t0 = performance.now();
    let r;
    try {
      r = await base.emoji(ws.uid, p.id, m.emoji, m.cible);
    } catch (e) {
      stats.erreursBase++;
      journal.error(`[partie ${p.id}] sticker :`, e.message);
      envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'base_indisponible' });
      return;
    }
    stats.msBaseTotal += performance.now() - t0;
    stats.stickers++;
    const res = r?.resultat ?? {};
    if (res.ok === true && r.ligne) {
      const l = r.ligne;
      diffuser(p, { t: 'emoji', partie: p.id, ligne: { id: l.id, de: l.de, a: l.a, emoji: l.emoji, prix: l.prix, created_at: l.created_at } });
    }
    envoyer(ws, { t: 'reponse', n: m.n, ok: res.ok === true, erreur: res.ok === true ? undefined : res.error, resultat: res });
  }

  async function accueillir(ws, m) {
    const uid = await verifierJeton(m.jeton);
    if (!uid) {
      envoyer(ws, { t: 'refus', raison: 'jeton' });
      ws.close(4001, 'jeton');
      return;
    }
    if (typeof m.partie !== 'string' || !UUID.test(m.partie)) {
      envoyer(ws, { t: 'refus', raison: 'partie' });
      ws.close(4004, 'partie');
      return;
    }
    const [e] = await base.etat([m.partie]);
    if (!e) {
      envoyer(ws, { t: 'refus', raison: 'partie_inconnue' });
      ws.close(4004, 'partie');
      return;
    }
    const assis = e.seats.some((s) => s.player_id === uid);
    // Spectateur : partie publique ou de tournoi, en cours ou terminée.
    const spectateur = !assis && m.spectateur === true;
    if (spectateur && (e.game.status === 'waiting' || (e.game.prive && !e.game.tournoi_id))) {
      envoyer(ws, { t: 'refus', raison: 'pas_spectateur' });
      ws.close(4003, 'table');
      return;
    }
    if (!assis && !spectateur && e.game.status === 'playing') {
      envoyer(ws, { t: 'refus', raison: 'pas_a_la_table' });
      ws.close(4003, 'table');
      return;
    }
    if (ws.readyState !== 1) return;

    if (ws.partie && ws.partie.id !== m.partie) {
      const ancienne = ws.partie;
      ancienne.clients.delete(ws);
      diffuserPresence(ancienne);
    }
    const p = obtenir(m.partie);
    ws.uid = uid;
    ws.spectateur = spectateur;
    if (spectateur) ws.pseudo = await pseudoDe(uid);
    if (ws.readyState !== 1) return;
    ws.partie = p;
    ws.proto = Number(m.proto) || 1;
    envoyer(ws, { t: 'bienvenue', uid, partie: p.id, spectateur, version: VERSION, proto: Math.min(ws.proto, PROTOCOLE), ep: EPOQUE, s: Date.now() });
    // L'état lu ici est d'abord donné aux autres téléphones (s'il a changé) ;
    // celui qui arrive reçoit ensuite le sien, une seule fois.
    if (!p.occupe) recevoirEtat(p, e, 'externe');
    p.clients.add(ws);
    planifier(p);
    if (p.etat) envoyerEtatA(ws, p, 'initial', { ep: m.ep, v: Number(m.v) });
    else envoyer(ws, messageEtat({ ...p, etat: e }, 'initial'));
    if (p.chat.length) envoyer(ws, { t: 'chat_historique', partie: p.id, messages: p.chat });
    diffuserPresence(p);
  }

  // Un téléphone vient de changer la partie par Supabase (rejoindre, revanche,
  // retrait…) : on relit tout de suite pour prévenir la table sans attendre
  // le prochain coup d'œil.
  function actualiser(ws) {
    const p = ws.partie;
    return enFile(p, async () => {
      const [e] = await base.etat([p.id]);
      if (e) recevoirEtat(p, e, 'externe');
    });
  }

  // -------------------------------------------------- coup d'œil régulier ----
  let sondageEnCours = false;
  async function sonder() {
    if (sondageEnCours) return;
    sondageEnCours = true;
    try {
      const attachees = [];
      const versions = new Map();
      for (const [id, p] of parties) {
        versions.set(id, p.version);
        if (p.clients.size) attachees.push(id);
      }
      if (!toutesLesParties && attachees.length === 0) {
        for (const [id, p] of parties) if (!p.occupe) { clearTimeout(p.minuterie); parties.delete(id); }
        return;
      }
      const liste = await base.etat(attachees, toutesLesParties);
      const vues = new Set();
      for (const e of liste) {
        const id = e.game.id;
        vues.add(id);
        const p = obtenir(id);
        if (p.occupe) continue;
        if (versions.has(id) && versions.get(id) !== p.version) continue; // un coup plus récent est passé
        recevoirEtat(p, e, 'externe');
      }
      for (const [id, p] of parties) {
        const terminee = !vues.has(id) || p.etat?.game?.status !== 'playing';
        if (p.clients.size === 0 && !p.occupe && (terminee || !toutesLesParties)) {
          clearTimeout(p.minuterie);
          parties.delete(id);
        }
      }
    } catch (e) {
      stats.erreursBase++;
      journal.error('[sondage]', e.message);
    } finally {
      sondageEnCours = false;
    }
  }

  // ----------------------------------------------------------- réseau ----
  const serveurHttp = http.createServer((req, res) => {
    if (req.url === '/sante') {
      const nb = stats.actions + stats.forces;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        ok: true, version: VERSION, demarre: stats.demarre,
        connexions: wss.clients.size, parties: parties.size, sessions: sessions.size, signaux: stats.signaux,
        actions: stats.actions, forces: stats.forces, stickers: stats.stickers, erreursBase: stats.erreursBase,
        latenceJoueursMs: { mediane: centile(rtts, 0.5), p90: centile(rtts, 0.9), mesures: rtts.length },
        latenceBaseMs: { mediane: centile(rttsBase, 0.5), p90: centile(rttsBase, 0.9), mesures: rttsBase.length },
        octetsEtat: stats.octetsEtat, octetsMaj: stats.octetsMaj, reprises: stats.reprises, reprisesCompletes: stats.reprisesCompletes,
        msBaseMoyen: nb ? Math.round(stats.msBaseTotal / nb) : null,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('LudoMiza — serveur de jeu');
  });

  // Compression des messages : négociée automatiquement avec le navigateur.
  // Fenêtre et mémoire réduites pour tenir des milliers de connexions.
  const wss = new WebSocketServer({
    server: serveurHttp,
    maxPayload: 4096,
    perMessageDeflate: {
      threshold: 96,
      serverMaxWindowBits: 13,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
    },
  });

  wss.on('connection', (ws, req) => {
    const origine = req.headers.origin;
    if (origines.length && origine && !origines.includes(origine)) {
      ws.close(1008, 'origine');
      return;
    }
    ws.vivant = true;
    ws.fenetre = Date.now();
    ws.compte = 0;
    ws.on('pong', () => {
      ws.vivant = true;
      if (ws.pingA) { noterRtt(Date.now() - ws.pingA); ws.pingA = 0; }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      fermerSession(ws);
      if (!ws.partie) return;
      ws.partie.clients.delete(ws);
      diffuserPresence(ws.partie);
    });

    ws.on('message', async (donnees) => {
      ws.vivant = true;
      const t = Date.now();
      if (t - ws.fenetre >= 1000) { ws.fenetre = t; ws.compte = 0; }
      const tropRapide = ++ws.compte > maxMessagesParSeconde;

      let m;
      try { m = JSON.parse(donnees.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (tropRapide) {
        // Jamais de silence : le téléphone doit savoir que son coup n'est pas parti.
        if (m.n != null) envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'trop_rapide' });
        return;
      }

      try {
        switch (m.t) {
          case 'ping':
            envoyer(ws, { t: 'pong', c: m.c, s: Date.now() });
            break;
          case 'bonjour':
            await accueillir(ws, m);
            break;
          case 'session': {
            // Ligne directe : identifie le joueur pour toute la durée de l'appli.
            const uid = await verifierJeton(m.jeton);
            if (!uid) { envoyer(ws, { t: 'refus', raison: 'jeton' }); ws.close(4001, 'jeton'); break; }
            if (ws.readyState !== 1) break;
            ouvrirSession(ws, uid);
            envoyer(ws, { t: 'session_ok', uid, version: VERSION, s: Date.now(), presence: true });
            break;
          }
          case 'visible':
            // L'appli passe à l'écran ou en arrière-plan : seule l'appli à
            // l'écran compte comme « présente ».
            ws.visible = m.v !== false;
            break;
          case 'en_ligne': {
            // Qui, parmi ces joueurs, a l'appli ouverte en ce moment ?
            if (!ws.session) { envoyer(ws, { t: 'en_ligne', n: m.n, ids: [] }); break; }
            const ids = Array.isArray(m.ids) ? m.ids.slice(0, 300).filter((x) => typeof x === 'string') : [];
            envoyer(ws, { t: 'en_ligne', n: m.n, ids: ids.filter((x) => sessions.has(x)) });
            break;
          }
          case 'actualiser':
            if (ws.partie && !ws.spectateur) await actualiser(ws);
            break;
          case 'reprendre':
            // Le téléphone a perdu le fil (différence qui ne s'applique pas) : état complet.
            if (ws.partie?.etat) envoyer(ws, messageEtat(ws.partie, 'reprise'));
            break;
          case 'reaction':
            relayerReaction(ws, m);
            break;
          case 'chat':
            await relayerChat(ws, m);
            break;
          case 'admin_spectateurs': {
            // La régie (jeton d'un compte admin) : qui regarde quelle partie.
            const uid = ws.adminUid || await verifierJeton(m.jeton);
            if (!uid || !(await estAdmin(uid))) { envoyer(ws, { t: 'refus', raison: 'pas_admin' }); ws.close(4003, 'admin'); break; }
            ws.adminUid = uid;
            envoyer(ws, { t: 'spectateurs', n: m.n, parties: listeSpectateurs(), s: Date.now() });
            break;
          }
          case 'admin_partie': {
            // (0.12.0) La régie suit une partie en direct : son état en mémoire (pions,
            // tour, dé), sans aucune lecture en base. absent = personne n'y est connecté.
            const uid = ws.adminUid || await verifierJeton(m.jeton);
            if (!uid || !(await estAdmin(uid))) { envoyer(ws, { t: 'refus', raison: 'pas_admin' }); ws.close(4003, 'admin'); break; }
            ws.adminUid = uid;
            const p = typeof m.partie === 'string' ? parties.get(m.partie) : null;
            if (!p?.etat) { envoyer(ws, { t: 'admin_partie', n: m.n, partie: m.partie, absent: true, s: Date.now() }); break; }
            envoyer(ws, { t: 'admin_partie', n: m.n, partie: p.id, game: p.etat.game, seats: p.etat.seats, v: p.version, s: Date.now() });
            break;
          }
          case 'emoji':
            if (ws.spectateur) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'spectateur' }); break; }
            if (!ws.partie) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'non_identifie' }); break; }
            await envoyerSticker(ws, m);
            break;
          case 'lancer':
          case 'quitter':
          case 'jouer': {
            if (!ws.partie) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'non_identifie' }); break; }
            if (ws.spectateur) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'spectateur' }); break; }
            let pion = null;
            if (m.t === 'jouer') {
              pion = Number(m.pion);
              if (!Number.isInteger(pion) || pion < 1 || pion > 4) {
                envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'bad_index' });
                break;
              }
            }
            await actionJoueur(ws, m.t, pion, m.n);
            break;
          }
          default:
            break;
        }
      } catch (e) {
        journal.error('[message]', e?.message ?? e);
        envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'erreur_serveur' });
      }
    });
  });

  // Connexions mortes (téléphone parti sans prévenir) : coupées au bout de ~30 s.
  const battement = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.vivant) { ws.terminate(); continue; }
      ws.vivant = false;
      ws.pingA = Date.now();
      ws.ping();
    }
  }, 15_000);
  let minuterieSondage = null;
  let minuterieSignaux = null;
  let minuteriePresence = null;

  return {
    parties,
    sessions,
    stats,
    async demarrer() {
      await new Promise((ok) => serveurHttp.listen(port, hote, ok));
      minuterieSondage = setInterval(sonder, sondageMs);
      await lireSignaux();   // point de départ du journal
      minuterieSignaux = setInterval(lireSignaux, signauxMs);
      minuteriePresence = setInterval(noterPresence, presenceMs);
      return serveurHttp.address().port;
    },
    async arreter() {
      clearInterval(battement);
      clearInterval(minuterieSondage);
      clearInterval(minuterieSignaux);
      clearInterval(minuteriePresence);
      for (const p of parties.values()) clearTimeout(p.minuterie);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((ok) => wss.close(() => ok()));
      await new Promise((ok) => serveurHttp.close(() => ok()));
      await Promise.all([...parties.values()].map((p) => p.file));
    },
    sonder,
    lireSignaux,
    noterPresence,
  };
}
