import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { creerArchiveChat } from '../src/archiveChat.js';

test('archive du chat : un fichier par jour, lecture par partie, purge après 30 jours', async () => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'lmz-arch-'));
  const ar = creerArchiveChat(d, { journal: { error: () => {} } });
  await ar.pret;
  const vieux = '2000-01-01.jsonl';
  await fsp.writeFile(path.join(d, vieux), '{}\n');
  const t = Date.now();
  ar.ajouter({ partie: 'p1', id: 'a', de: 'u1', pseudo: 'Paul', texte: 'salut', spect: false, cible: null, a: t });
  ar.ajouter({ partie: 'p2', id: 'b', de: 'u2', pseudo: 'Ali', texte: 'yo', spect: true, cible: null, a: t + 1 });
  ar.ajouter({ partie: 'p1', id: 'c', de: 'u2', pseudo: 'Ali', texte: '***', spect: false, cible: 'u1', a: t + 2 }, 'idiot');
  const p1 = await ar.lirePartie('p1', t);
  assert.deepEqual(p1.map((m) => m.id), ['a', 'c']);
  assert.equal(p1[1].brut, 'idiot');
  assert.equal(p1[0].brut, undefined);
  assert.equal(await ar.purger(), 1);
  assert.ok(!(await fsp.readdir(d)).includes(vieux));
  await ar.fermer();
  await fsp.rm(d, { recursive: true, force: true });
});

test('archive du chat : sans dossier, rien n\'est écrit et rien ne casse', async () => {
  const ar = creerArchiveChat(null);
  ar.ajouter({ partie: 'p', id: 'x', a: Date.now() });
  assert.equal(ar.actif, false);
  assert.deepEqual(await ar.lirePartie('p'), []);
  await ar.fermer();
});
