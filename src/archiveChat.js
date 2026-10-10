/*
  Archive du chat des parties (0.13.0) : sur le disque du serveur de jeu, jamais en base.

  - Un fichier par jour (UTC) : AAAA-MM-JJ.jsonl, une ligne JSON par message
    { partie, id, de, pseudo, texte, brut?, spect, cible, a }.
    brut : le texte tapé, seulement s'il diffère de ce qui a été affiché (insultes masquées).
  - Les fichiers de plus de `jours` jours sont supprimés (au démarrage puis toutes les 6 h).
  - Écritures regroupées : au plus une écriture disque par seconde.
  - Dossier : $CHAT_DOSSIER, sinon $STATE_DIRECTORY/chat (systemd « StateDirectory=ludomiza »).
    Sans dossier accessible en écriture, rien n'est archivé (le chat marche quand même).
*/
import { promises as fs } from 'node:fs';
import path from 'node:path';

const JOUR_MS = 86_400_000;
const jourDe = (ms) => new Date(ms).toISOString().slice(0, 10);

export function creerArchiveChat(dossier, { jours = 30, journal = console, purgeMs = 6 * 3600_000 } = {}) {
  let actif = Boolean(dossier);
  let attente = [];             // messages pas encore écrits
  let ecriture = Promise.resolve();
  let minuterie = null;
  let purge = null;

  async function preparer() {
    if (!actif) return false;
    try {
      await fs.mkdir(dossier, { recursive: true });
      await fs.access(dossier, fs.constants?.W_OK ?? 2);
      return true;
    } catch (e) {
      journal.error('[archive chat] dossier inaccessible, archive désactivée :', dossier, e?.message ?? e);
      actif = false;
      return false;
    }
  }
  const pret = preparer().then(async (ok) => { if (ok) await purgerInterne(); return ok; });

  function vider() {
    minuterie = null;
    if (!attente.length) return ecriture;
    const lot = attente;
    attente = [];
    const parJour = new Map();
    for (const m of lot) {
      const j = jourDe(m.a);
      parJour.set(j, (parJour.get(j) || '') + JSON.stringify(m) + '\n');
    }
    ecriture = ecriture.then(async () => {
      if (!(await pret)) return;
      for (const [j, txt] of parJour) {
        try { await fs.appendFile(path.join(dossier, `${j}.jsonl`), txt, 'utf8'); }
        catch (e) { journal.error('[archive chat] écriture', e?.message ?? e); }
      }
    });
    return ecriture;
  }

  function ajouter(msg, brut = null) {
    if (!actif) return;
    const ligne = { partie: msg.partie, id: msg.id, de: msg.de, pseudo: msg.pseudo, texte: msg.texte,
                    spect: msg.spect, cible: msg.cible, a: msg.a };
    if (brut && brut !== msg.texte) ligne.brut = brut.slice(0, 400);
    attente.push(ligne);
    if (!minuterie) minuterie = setTimeout(vider, 1000);
  }

  /* Messages d'une partie : on lit les fichiers des jours autour de `depuisMs` (création de la partie). */
  async function lirePartie(partie, depuisMs = Date.now(), joursMax = 3) {
    await vider();
    if (!(await pret)) return [];
    const out = [];
    const debut = Math.max(depuisMs - JOUR_MS, Date.now() - jours * JOUR_MS);
    for (let k = 0; k <= joursMax; k++) {
      const t = debut + k * JOUR_MS;
      if (t > Date.now() + JOUR_MS) break;
      let txt;
      try { txt = await fs.readFile(path.join(dossier, `${jourDe(t)}.jsonl`), 'utf8'); } catch { continue; }
      if (!txt.includes(partie)) continue;
      for (const l of txt.split('\n')) {
        if (!l || !l.includes(partie)) continue;
        try { const m = JSON.parse(l); if (m.partie === partie) out.push(m); } catch { /* ligne abîmée */ }
      }
    }
    const vus = new Set();
    return out.filter((m) => (vus.has(m.id) ? false : vus.add(m.id))).sort((a, b) => a.a - b.a);
  }

  async function purger() {
    if (!(await pret)) return 0;
    return purgerInterne();
  }
  async function purgerInterne() {
    const limite = jourDe(Date.now() - jours * JOUR_MS);
    let n = 0;
    try {
      for (const f of await fs.readdir(dossier)) {
        const j = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1];
        if (j && j < limite) { await fs.unlink(path.join(dossier, f)); n++; }
      }
    } catch (e) { journal.error('[archive chat] purge', e?.message ?? e); }
    return n;
  }
  if (actif) { purge = setInterval(purger, purgeMs); purge.unref?.(); }

  async function fermer() {
    if (purge) clearInterval(purge);
    if (minuterie) clearTimeout(minuterie);
    await vider();
  }

  return { ajouter, lirePartie, purger, fermer, get actif() { return actif; }, pret };
}
