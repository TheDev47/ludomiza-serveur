// Différences entre deux états d'une partie (protocole 2).
//
// Au lieu de renvoyer toute la partie à chaque coup, le serveur n'envoie que
// ce qui a changé : quelques champs de la partie et des sièges concernés.
// Le téléphone garde sa copie et y applique la différence. La même fonction
// « appliquer » est recopiée dans le jeu (ludo-app/src/lib/serveurJeu.js).
//
// Format d'une différence :
//   g : { champ: nouvelleValeur, … }        champs de la partie qui ont changé
//   s : { joueur: { champ: valeur, … } }    champs des sièges qui ont changé
//   S : [ …sièges ]                         tous les sièges (arrivée / départ)
//   r : revanche                            présente seulement si elle a changé

const pareil = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function champsChanges(avant = {}, apres = {}) {
  const d = {};
  let n = 0;
  for (const k of new Set([...Object.keys(avant), ...Object.keys(apres)])) {
    if (!pareil(avant[k], apres[k])) { d[k] = k in apres ? apres[k] : null; n++; }
  }
  return n ? d : null;
}

/** Différence pour passer de l'état « avant » à l'état « apres ». */
export function difference(avant, apres) {
  const d = {};
  const g = champsChanges(avant.game, apres.game);
  if (g) d.g = g;
  const ids = (e) => (e.seats || []).map((s) => s.player_id).join(',');
  if (ids(avant) !== ids(apres)) {
    d.S = apres.seats;
  } else {
    const parJoueur = new Map((avant.seats || []).map((x) => [x.player_id, x]));
    const s = {};
    let n = 0;
    for (const x of apres.seats || []) {
      const c = champsChanges(parJoueur.get(x.player_id), x);
      if (c) { s[x.player_id] = c; n++; }
    }
    if (n) d.s = s;
  }
  if (!pareil(avant.revanche ?? null, apres.revanche ?? null)) d.r = apres.revanche ?? null;
  return d;
}

/** Applique une différence (renvoie un nouvel état, l'ancien n'est pas modifié). */
export function appliquer(etat, d) {
  const game = d.g ? { ...etat.game, ...d.g } : etat.game;
  let seats = etat.seats;
  if (d.S) seats = d.S;
  else if (d.s) seats = seats.map((x) => (d.s[x.player_id] ? { ...x, ...d.s[x.player_id] } : x));
  const revanche = 'r' in d ? d.r : (etat.revanche ?? null);
  return { game, seats, revanche };
}
