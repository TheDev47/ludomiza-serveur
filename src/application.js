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

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

export const VERSION = '0.3.0';

// Délais appliqués par la base (force_turn / force_move). Le serveur déclenche
// l'action automatique juste après ; la base revérifie de toute façon.
export const DELAIS_MS = {
  lancer: 17_000, // force_turn : 17 s après le début du tour
  pion: 19_000, // force_move : 19 s après le début du tour…
  apresLancer: 9_000, // …et 9 s après un lancer manuel
  apresLancerAuto: 2_000, // …ou 2 s après un lancer automatique
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Instant (horloge de la base, en ms) à partir duquel l'action automatique est permise.
export function echeance(game) {
  if (!game || game.status !== 'playing') return null;
  const debutTour = game.turn_started_at ? Date.parse(game.turn_started_at) : null;
  if (!game.must_move) return debutTour == null ? 0 : debutTour + DELAIS_MS.lancer;
  const lance = game.rolled_at ? Date.parse(game.rolled_at) : debutTour;
  return Math.max(
    debutTour == null ? 0 : debutTour + DELAIS_MS.pion,
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
  journal = console,
} = {}) {
  const parties = new Map();
  const stats = { demarre: new Date().toISOString(), actions: 0, forces: 0, stickers: 0, erreursBase: 0, msBaseTotal: 0 };

  // ------------------------------------------------------------- parties ----
  function obtenir(id) {
    let p = parties.get(id);
    if (!p) {
      p = { id, etat: null, sig: '', version: 0, clients: new Set(), file: Promise.resolve(),
            occupe: 0, minuterie: null, decalage: 0, essaisForce: 0 };
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
    return { t: 'etat', partie: p.id, game: p.etat.game, seats: p.etat.seats, revanche: p.etat.revanche ?? null, cause, ...extra, s: Date.now() };
  }

  // Présence : qui, à cette table, a une connexion ouverte avec le serveur.
  // Envoyé à chaque arrivée ou départ ; le téléphone attend quelques secondes
  // avant d'afficher « hors ligne » (une reconnexion rapide ne se voit pas).
  function connectes(p) {
    return [...new Set([...p.clients].filter((w) => w.readyState === 1 && w.uid).map((w) => w.uid))];
  }
  function diffuserPresence(p) {
    diffuser(p, { t: 'presence', partie: p.id, connectes: connectes(p) });
  }

  // Nouvel état venu de la base : on le garde, on le diffuse s'il a changé,
  // et on recale le chronomètre.
  function recevoirEtat(p, etat, cause, extra = {}, { toujours = false, minuterie = true } = {}) {
    if (!etat?.game) return;
    if (etat.maintenant) p.decalage = Date.parse(etat.maintenant) - Date.now();
    const sig = JSON.stringify([etat.game, etat.seats, etat.revanche ?? null]);
    const change = sig !== p.sig;
    if (change) {
      p.sig = sig;
      p.etat = etat;
      p.version++;
    }
    if (change || toujours) diffuser(p, messageEtat(p, cause, extra));
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
    if (!assis && e.game.status === 'playing') {
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
    ws.partie = p;
    p.clients.add(ws);
    envoyer(ws, { t: 'bienvenue', uid, partie: p.id, version: VERSION, s: Date.now() });
    if (!p.occupe) recevoirEtat(p, e, 'externe');
    else planifier(p);
    envoyer(ws, messageEtat(p.etat ? p : { ...p, etat: e }, 'initial'));
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
        connexions: wss.clients.size, parties: parties.size,
        actions: stats.actions, forces: stats.forces, stickers: stats.stickers, erreursBase: stats.erreursBase,
        msBaseMoyen: nb ? Math.round(stats.msBaseTotal / nb) : null,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('LudoMiza — serveur de jeu');
  });

  const wss = new WebSocketServer({ server: serveurHttp, maxPayload: 4096 });

  wss.on('connection', (ws, req) => {
    const origine = req.headers.origin;
    if (origines.length && origine && !origines.includes(origine)) {
      ws.close(1008, 'origine');
      return;
    }
    ws.vivant = true;
    ws.fenetre = Date.now();
    ws.compte = 0;
    ws.on('pong', () => { ws.vivant = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
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
          case 'actualiser':
            if (ws.partie) await actualiser(ws);
            break;
          case 'emoji':
            if (!ws.partie) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'non_identifie' }); break; }
            await envoyerSticker(ws, m);
            break;
          case 'lancer':
          case 'quitter':
          case 'jouer': {
            if (!ws.partie) { envoyer(ws, { t: 'reponse', n: m.n, ok: false, erreur: 'non_identifie' }); break; }
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
      ws.ping();
    }
  }, 15_000);
  let minuterieSondage = null;

  return {
    parties,
    stats,
    async demarrer() {
      await new Promise((ok) => serveurHttp.listen(port, hote, ok));
      minuterieSondage = setInterval(sonder, sondageMs);
      return serveurHttp.address().port;
    },
    async arreter() {
      clearInterval(battement);
      clearInterval(minuterieSondage);
      for (const p of parties.values()) clearTimeout(p.minuterie);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((ok) => wss.close(() => ok()));
      await new Promise((ok) => serveurHttp.close(() => ok()));
      await Promise.all([...parties.values()].map((p) => p.file));
    },
    sonder,
  };
}
