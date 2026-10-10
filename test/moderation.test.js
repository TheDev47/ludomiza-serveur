import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifierMessage, suitesDeChiffres, masquerInsultes } from '../src/moderation.js';

const BLOQUES = [
  '699123456', '6 99 12 34 56', '+237 6 99 12 34 56', '6.99.12.34.56', '6-99-12-34-56', '(237) 699-12-34-56',
  'écris moi au 699 12 34 56', 'mon num 6 9 9 1 2 3 4 5 6', '69O l2 34 56', '６９９１２３４５６', '٦٩٩١٢٣٤٥٦',
  '6️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣', '6​9​9​1​2​3​4​5​6',
  'six neuf neuf un deux trois quatre cinq six', 'six quatre-vingt-dix-neuf douze trente-quatre cinquante-six',
  'six quatre vingt dix neuf douze trente quatre cinquante six', 'six double nine one two three four five six',
  'six 99 douze 34 cinquante-six', 'whatsapp 6991', 'wa 2345', 'appelle moi 6 99 1', '07 08 09 10 11', '70 123 45 67',
];
const PERMIS = [
  'Bien joué frère', 'Ce 6 là c\'est pour toi 😂', 'on joue 500 F ?', 'mise de 50 000 F', 'score 3-2', 'il reste 2 pions',
  'GG', '1000 fcfa la prochaine', 'six six six 😈', 'à 21:30 on rejoue', 'j\'ai fait 3 six de suite', 'ok 👍',
  'tu as gagné 10 000 F bravo', 'deux fois six', '10 20 30 40', 'merci 1 2 3 4 5 6 7 8', 'tu es nul 12345678 fois', '100 200 300 400 500',
];
test('numéros bloqués (avec suspension)', () => {
  for (const m of BLOQUES) {
    const r = verifierMessage(m, {});
    assert.equal(r.ok, false, `devait bloquer : ${m}`);
    assert.equal(r.sanction, 'suspension', `devait suspendre : ${m}`);
  }
});
test('messages normaux acceptés', () => {
  for (const m of PERMIS) {
    const r = verifierMessage(m, {});
    assert.equal(r.ok, true, `devait accepter : ${m} (${JSON.stringify(suitesDeChiffres(m))})`);
  }
});
test('numéro découpé sur plusieurs messages', () => {
  const mem = {};
  let t = 1000;
  assert.equal(verifierMessage('699', mem, t).ok, true);
  assert.equal(verifierMessage('12 34', mem, t += 3000).ok, true);
  const r = verifierMessage('56', mem, t += 3000);
  assert.equal(r.ok, false); assert.equal(r.sanction, 'suspension');
  const mem2 = {};
  assert.equal(verifierMessage('six neuf neuf', mem2, 1).ok, true);
  assert.equal(verifierMessage('douze trente quatre cinquante six', mem2, 2).ok, false);
});
test('liens et e-mails refusés sans suspension', () => {
  for (const m of ['wa.me/abc', 'va sur www.site.com', 'mon mail toto@gmail.com', 'https://t.me/groupe']) {
    const r = verifierMessage(m, {});
    assert.equal(r.ok, false, m); assert.equal(r.sanction, undefined, m);
  }
});
test('insultes graves masquées', () => {
  for (const [m, attendu] of [['espèce de connard', 'espèce de ***'], ['c0nnaaard va', '*** va'], ['fils de pute', 'fils de ***'], ['you bitch', 'you ***']]) {
    assert.equal(verifierMessage(m, {}).texte, attendu, m);
  }
  assert.equal(verifierMessage('passe le dé', {}).texte, 'passe le dé');
  assert.equal(masquerInsultes('Bien joué').masque, false);
});
