# LudoMiza — serveur de jeu

Petit programme Node.js qui rend les parties en ligne fluides.

## Ce qu'il fait

- Chaque téléphone garde **une connexion ouverte** (WebSocket) avec ce serveur pendant la partie.
- « Je lance » ou « je joue le pion 3 » arrive ici. Le serveur appelle **les fonctions qui existent déjà dans Supabase** (`roll_dice`, `move_pawn`…) en un seul aller-retour, puis envoie l'état à jour à **tous les joueurs de la table** d'un coup.
- Il déclenche lui-même les **tours automatiques** quand le chronomètre est écoulé (17 s / 19 s), à la seconde près.
- Toutes les 1 s, il jette un coup d'œil à la base pour relayer ce qui s'est passé ailleurs (abandon, régie, ancienne version du jeu…).

## Ce qu'il ne fait pas (volontairement)

- Il **ne recopie aucune règle** du Ludo : les règles, le hasard du dé, les mises, les gains et les tournois restent dans Supabase.
- Il **ne touche à aucun solde** et ne peut pas lire les tables : son rôle dans la base (`serveur_jeu`) peut seulement appeler `_serveur_etat` et `_serveur_action` (voir `sql/01_serveur_jeu.sql`).
- S'il s'arrête, rien n'est perdu : la partie est toujours à jour dans Supabase et le jeu revient à l'ancien fonctionnement.

## Messages échangés

Téléphone → serveur :

| Message | Rôle |
|---|---|
| `{t:'bonjour', jeton, partie}` | S'identifier (jeton de connexion Supabase du joueur) |
| `{t:'lancer', n}` | Lancer le dé |
| `{t:'jouer', pion, n}` | Jouer le pion 1 à 4 |
| `{t:'quitter', n}` | Abandonner |
| `{t:'ping', c}` | Mesurer la latence |

Serveur → téléphone : `bienvenue`, `refus`, `etat` (même forme que la réponse de `move_pawn` : `game` + `seats`), `reponse` (résultat de SON action), `pong`.

## Réglages (variables d'environnement)

Voir le haut de `src/index.js`. Les valeurs secrètes (`DATABASE_URL`) vont **uniquement** dans `/etc/ludomiza/serveur.env` sur le VPS, jamais dans ce dépôt.

## Tests

`npm test` : parties complètes jouées par des robots sur une **copie locale** de la base (voir `test/LISEZ-MOI.md`), chronomètres, droits, sécurité, 20 parties simultanées.
