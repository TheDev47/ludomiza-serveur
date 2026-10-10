// Modération du chat des parties : vérifié sur le serveur de jeu, AVANT tout envoi.
//
//   verifierMessage(texte, memoire) -> { ok, texte, raison?, sanction? }
//     ok:false + sanction:'suspension' : numéro de téléphone (chat suspendu 24 h)
//     ok:false sans sanction           : lien ou adresse e-mail (message refusé)
//     ok:true                          : texte à diffuser (insultes graves masquées par ***)
//
// Le numéro est cherché sous toutes ses formes :
//   - chiffres séparés ou collés : « 6 99 12 34 56 », « 6.99-12/34 », « +237 699… »
//   - chiffres d'autres écritures, entourés, pleine largeur, touches (6️⃣), espaces invisibles
//   - lettres prises pour des chiffres au milieu d'un nombre : « 69O l2 » -> 690 12
//   - chiffres écrits en lettres, en français et en anglais, nombres composés compris :
//     « six quatre-vingt-dix-neuf douze trente-quatre », « nine double one »
//   - numéro coupé sur plusieurs messages (mémoire des derniers messages du joueur)
// Un montant (« 50 000 F »), un score (« 3-2 ») ou un petit nombre ne déclenchent rien :
// il faut une suite d'au moins 8 chiffres.

export const LONGUEUR_MAX = 200;
const CHIFFRES_MIN = 8;            // plus courts numéros de la zone : 8 chiffres (Burkina Faso)
const MEMOIRE_MS = 120_000;        // un numéro découpé sur 2 minutes de messages

// ------------------------------------------------------------ normalisation ----
const ZEROS = [0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40,
  0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10];
function chiffreUnicode(c) {
  const code = c.codePointAt(0);
  for (const z of ZEROS) if (code >= z && code <= z + 9) return String(code - z);
  return null;
}

// Lettres d'autres alphabets qui ressemblent à des lettres latines (cyrillique, grec)
const SOSIES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'ο': 'o', 'ι': 'i', 'ν': 'v', 'κ': 'k', 'τ': 't', 'α': 'a', 'ε': 'e', 'ρ': 'p', 'ѵ': 'v' };

export function normaliser(texte) {
  let s = String(texte ?? '').normalize('NFKC');
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\uFE0F\u20E3]/g, '');   // invisibles, touches 6️⃣
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');                                   // accents
  s = s.toLowerCase();
  let out = '';
  for (const c of s) {
    const d = /\p{Nd}/u.test(c) ? chiffreUnicode(c) : null;
    out += d ?? SOSIES[c] ?? c;
  }
  return out;
}

// ------------------------------------------------------ nombres en lettres ----
const UNITES = {
  zero: 0, zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  oh: 0, nil: 0, one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
};
const DIX_A_SEIZE = {
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const DIZAINES = {
  vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, septante: 70, huitante: 80, octante: 80, nonante: 90,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const CENTS = { cent: 100, cents: 100, hundred: 100 };
const LIENS = new Set(['et', 'and', '-']);
const DOUBLES = { double: 2, triple: 3 };

function estMotNombre(m) {
  return m in UNITES || m in DIX_A_SEIZE || m in DIZAINES || m in CENTS || m in DOUBLES;
}

// « six quatre-vingt-dix-neuf douze » -> "69912". Un nombre se termine quand le mot
// suivant ne peut pas le prolonger (deux unités qui se suivent = deux chiffres dictés).
function lettresEnChiffres(mots) {
  let sortie = '';
  let n = null;          // nombre en cours
  let etape = 0;         // 0 rien, 1 unité seule, 2 dizaine, 3 dizaine+unité/dix, 4 centaine
  let repeter = 1;
  const finir = () => { if (n !== null) { sortie += String(n).repeat(repeter); repeter = 1; } n = null; etape = 0; };
  for (let i = 0; i < mots.length; i++) {
    const m = mots[i];
    if (LIENS.has(m)) continue;
    if (m in DOUBLES) { finir(); repeter = DOUBLES[m]; continue; }
    if (m in CENTS) {
      n = (n === null ? 1 : n) * 100; etape = 4; continue;
    }
    if (m in DIZAINES) {
      const v = DIZAINES[m];
      if (v === 20 && n !== null && n % 100 === 4 && etape === 1) { n = n - 4 + 80; etape = 2; continue; }  // quatre-vingt
      if (etape === 4 && n % 100 === 0) { n += v; etape = 2; continue; }
      finir(); n = v; etape = 2; continue;
    }
    if (m in DIX_A_SEIZE) {
      const v = DIX_A_SEIZE[m];
      if ((etape === 2 && (n % 100 === 60 || n % 100 === 80)) || (etape === 4 && n % 100 === 0)) { n += v; etape = 3; continue; }
      finir(); n = v; etape = 3; continue;
    }
    if (m in UNITES) {
      const v = UNITES[m];
      if ((etape === 2 && v > 0) || (etape === 4 && n % 100 === 0)) { n += v; etape = etape === 4 ? 1 : 3; continue; }
      finir(); n = v; etape = 1; continue;
    }
  }
  finir();
  return sortie;
}

// -------------------------------------------------------- suites de chiffres ----
// Découpe le texte normalisé en morceaux : chiffres, mots-nombres, autres mots, séparateurs.
// Une suite continue de morceaux « nombre » (avec séparateurs entre eux) donne une suite de chiffres.
const SEPARATEURS = /^[\s.,;:/\\\-_+()[\]{}*#~'"`^|=<>!?]+$/;
const BOUCHE_TROU = new Set(['au', 'le', 'la', 'mon', 'ma', 'num', 'no', 'n', 'tel', 'tél', 'is', 'my', 'at', 'call', 'appelle', 'ecris', 'ecrit', 'moi', 'me']);

// Montants et scores à ne pas compter comme des chiffres de numéro
function retirerMontants(s) {
  return s
    .replace(/\d[\d\s.]*\s*(?:f\b|fcfa\b|cfa\b|francs?\b|xaf\b|xof\b|k\b|mille\b)/g, ' ')
    .replace(/(?<![\d\-:.\s]\s?)(?<![\d\-:.])\b\d{1,2}\s*[-:]\s*\d{1,2}\b(?!\s*[-:.]\s*\d)/g, ' ');   // 3-2, 12:30 (pas 6-99-12-34)
}

function morceaux(s) {
  return s.match(/\d+|[a-z]+|[^\da-z]+/g) ?? [];
}

// Lettres qui, collées à des chiffres, en sont probablement : 69O l2 -> 69012
function confondre(m, voisinChiffre) {
  if (!voisinChiffre) return null;
  if (/^[oil]+$/.test(m) && m.length <= 3) return m.replace(/o/g, '0').replace(/[il]/g, '1');
  return null;
}

/** Plus longue suite de chiffres « dictée » dans le texte, et celle qui touche la fin et le début. */
export function suitesDeChiffres(texte) {
  const s = retirerMontants(normaliser(texte));
  const ms = morceaux(s);
  const suites = [];
  let courante = '';
  let motsNombres = [];
  let debut = true;
  let premiere = null;
  const vider = () => { if (motsNombres.length) { courante += lettresEnChiffres(motsNombres); motsNombres = []; } };
  const couper = () => {
    vider();
    if (courante) suites.push(courante);
    if (premiere === null) premiere = debut ? courante : '';
    courante = '';
    debut = false;
  };
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (/^\d+$/.test(m)) { vider(); courante += m; continue; }
    if (SEPARATEURS.test(m)) continue;
    if (/^[a-z]+$/.test(m)) {
      const autour = /^\d/.test(ms[i + 1] ?? '') || /\d$/.test(ms[i - 1] ?? '')
        || (/^\d/.test(ms[i + 2] ?? '') && SEPARATEURS.test(ms[i + 1] ?? '') && (ms[i + 1] ?? '').length <= 2);
      const conf = confondre(m, autour && /\d$/.test(ms[i - 1] ?? '') || /^\d/.test(ms[i + 1] ?? ''));
      if (conf !== null) { vider(); courante += conf; continue; }
      if (estMotNombre(m)) { motsNombres.push(m); continue; }
      if (LIENS.has(m)) continue;
      if (BOUCHE_TROU.has(m) && !courante && !motsNombres.length) continue;
      couper();
      continue;
    }
    couper();
  }
  vider();
  const finale = courante;
  if (courante) suites.push(courante);
  if (premiere === null) premiere = courante;
  const longue = suites.reduce((a, b) => (b.length > a.length ? b : a), '');
  return { longue, debut: premiere ?? '', fin: finale };
}

// ------------------------------------------------------------ liens, e-mails ----
const LIEN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|cm|ci|sn|bf|io|me|ly|gg|app|link|xyz|info|fr)\b|wa\.me|t\.me|chat\.whatsapp|bit\.ly)/i;
const EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\.[a-z]{2,}/i;
// Mots qui annoncent un contact hors de l'appli : avec quelques chiffres, c'est un numéro
const CONTACT = /\b(whats?app|watsap|wtsp|wa|telegram|tg|signal|imo|appel+e?[sz]?|numero|num|contact|tel|phone|call|text\s*me|ecri[st]-?moi)\b/;

// ------------------------------------------------------------------ insultes ----
// Insultes graves (français, anglais, camfranglais) : masquées par ***.
const INSULTES = [
  'connard', 'connasse', 'salope', 'salaud', 'pute', 'putes', 'encule', 'enculer', 'encules', 'fdp', 'ntm', 'nique',
  'niquer', 'batard', 'batards', 'pd', 'pede', 'tapette', 'negre', 'negro', 'bougnoule', 'youpin', 'chienne', 'trouduc',
  'ashawo', 'asawo', 'motherfucker', 'fuck', 'fucker', 'fucking', 'bitch', 'bitches', 'whore', 'slut', 'cunt', 'asshole',
  'nigger', 'nigga', 'faggot', 'fag', 'bastard', 'dick', 'pussy', 'retard',
];
const EXPRESSIONS = [/fils\s*de\s*pute/g, /ta\s*m[eè]re\s*la\s*pute/g, /nique\s*ta\s*m[eè]re/g, /suce\s*ma/g, /son\s*of\s*a\s*bitch/g];
// Même mot écrit avec chiffres ou lettres doublées : « c0nnard », « saloooope », « p.u.t.e »
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };
function cleInsulte(mot) {
  return normaliser(mot).replace(/[01345 78@$]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
}
const INSULTES_CLES = new Set(INSULTES.map((m) => m.replace(/(.)\1+/g, '$1')));

export function masquerInsultes(texte) {
  let s = String(texte);
  let masque = false;
  // mots un par un (le mot d'origine est remplacé, la ponctuation gardée)
  s = s.replace(/[\p{L}\p{N}@$.*]+/gu, (mot) => {
    const cle = cleInsulte(mot);
    if (cle && INSULTES_CLES.has(cle)) { masque = true; return '***'; }
    return mot;
  });
  // expressions sur plusieurs mots
  const n = normaliser(s);
  for (const re of EXPRESSIONS) {
    re.lastIndex = 0;
    if (re.test(n)) { masque = true; s = '***'; break; }
  }
  return { texte: s, masque };
}

// ---------------------------------------------------------- vraisemblance ----
// Une suite de 8 ou 9 chiffres n'est un numéro que si elle commence comme un numéro de la zone :
//   Cameroun 6… ou 2… (9), Sénégal 7… ou 3… (9), Côte d'Ivoire 0… (10), Burkina Faso 0/2/5/6/7… (8).
// À partir de 10 chiffres, c'est toujours bloqué (indicatif + numéro, autres pays).
export function ressembleAUnNumero(suite, groupes = []) {
  if (!suite || suite.length < CHIFFRES_MIN) return false;
  // « 10 20 30 40 », « 100 200 300 » : des montants ou des scores, pas un numéro
  if (groupes.length >= 2 && groupes.every((g) => /0$/.test(g))) return false;
  if (suite.length >= 10) return true;
  if (suite.length === 9) return /^[2367]/.test(suite);
  return /^[025-7]/.test(suite);
}

// ------------------------------------------------------------------ verdict ----
/**
 * @param texte   message brut
 * @param memoire objet propre à (partie, joueur), gardé par l'appelant : { chiffres, a }
 */
export function verifierMessage(texte, memoire = {}, maintenant = Date.now()) {
  let brut = String(texte ?? '').replace(/\s+/g, ' ').trim();
  if (!brut) return { ok: false, raison: 'vide' };
  if (brut.length > LONGUEUR_MAX) brut = brut.slice(0, LONGUEUR_MAX);

  const n = normaliser(brut);
  const { longue, debut, fin } = suitesDeChiffres(brut);

  const groupes = retirerMontants(n).match(/\d+/g) || [];
  // 1. Numéro dans le message
  if (ressembleAUnNumero(longue, groupes)) return { ok: false, raison: 'numero', sanction: 'suspension' };
  // 2. Mot « contact » + au moins 4 chiffres : c'est une tentative
  if (CONTACT.test(n) && longue.length >= 4) return { ok: false, raison: 'numero', sanction: 'suspension' };

  // 3. Numéro découpé sur plusieurs messages
  const recent = memoire.a && maintenant - memoire.a < MEMOIRE_MS ? memoire.chiffres || '' : '';
  const seulementDesChiffres = suitesDeChiffres(brut).longue.length > 0 && !/[a-z]{4,}/.test(n.replace(/\b(?:zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|one|two|three|four|five|seven|eight|nine|double|triple)\b/g, ''));
  const enchaine = recent + debut;
  if (recent && debut && ressembleAUnNumero(enchaine)) return { ok: false, raison: 'numero', sanction: 'suspension' };
  // ce qui reste en mémoire pour le prochain message
  memoire.chiffres = seulementDesChiffres ? (recent + (fin || debut)).slice(-12) : (fin || '');
  memoire.a = maintenant;

  // 4. Liens et e-mails : refusés, sans suspension
  if (LIEN.test(n) || EMAIL.test(n)) return { ok: false, raison: 'lien' };

  // 5. Insultes graves : masquées
  const { texte: propre, masque } = masquerInsultes(brut);
  return { ok: true, texte: propre, masque };
}
