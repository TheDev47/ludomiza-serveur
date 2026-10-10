# LudoMiza — serveur de jeu

Petit programme Node.js qui rend les parties en ligne fluides.

## Ce qu'il fait

- Chaque téléphone garde **une connexion ouverte** (WebSocket) avec ce serveur pendant la partie.
- « Je lance » ou « je joue le pion 3 » arrive ici. Le serveur appelle **les fonctions qui existent déjà dans Supabase** (`roll_dice`, `move_pawn`…) en un seul aller-retour, puis envoie l'état à jour à **tous les joueurs de la table** d'un coup.
- Il déclenche lui-même les **tours automatiques** quand le chronomètre est écoulé (17 s / 19 s), à la seconde près.
- Toutes les 1 s, il jette un coup d'œil à la base pour relayer ce qui s'est passé ailleurs (abandon, régie, ancienne version du jeu…).

- Il tient une **ligne directe** avec chaque téléphone ouvert : une fois par seconde, il lit le journal des signaux de la base (`_serveur_evenements`, voir `sql/04_serveur_signaux.sql`) et prévient chaque joueur de ce qu'il doit relire. L'appli n'a alors plus besoin du temps réel de Supabase, limité en formule gratuite (200 connexions simultanées).

## Ce qu'il ne fait pas (volontairement)

- Il **ne recopie aucune règle** du Ludo : les règles, le hasard du dé, les mises, les gains et les tournois restent dans Supabase.
- Il **ne touche à aucun solde** et ne peut pas lire les tables : son rôle dans la base (`serveur_jeu`) peut seulement appeler `_serveur_etat` et `_serveur_action` (voir `sql/01_serveur_jeu.sql`).
- S'il s'arrête, rien n'est perdu : la partie est toujours à jour dans Supabase et le jeu revient à l'ancien fonctionnement.

## Messages échangés

Téléphone → serveur :

| Message | Rôle |
|---|---|
| `{t:'bonjour', jeton, partie, proto?, ep?, v?, spectateur?}` | S'identifier (jeton de connexion Supabase du joueur). `spectateur: true` (0.7.0) : regarder une partie publique ou de tournoi, en cours ou terminée, sans pouvoir y jouer. `proto: 2` (0.5.0) : recevoir des différences ; `ep` + `v` : dernière version connue, pour une reprise légère après coupure |
| `{t:'reprendre'}` | (protocole 2) Redemander l'état complet quand une différence ne s'applique pas |
| `{t:'lancer', n}` | Lancer le dé |
| `{t:'jouer', pion, n}` | Jouer le pion 1 à 4 |
| `{t:'quitter', n}` | Abandonner |
| `{t:'emoji', emoji, cible, n}` | Envoyer un sticker (payé par la base, montré à toute la table) |
| `{t:'reaction', code, cible?}` | (0.7.0) **Spectateur** seulement : réaction toute prête (code court, ex. `feu`), éventuellement adressée à un joueur assis (`cible`, 0.8.0), relayée à toute la table sans rien écrire en base. Au plus une toutes les 2,5 s par spectateur et 12 par seconde par table |
| `{t:'chat', texte, cible?}` | (0.11.0 ; `cible` 0.11.1 : joueur assis à qui le message est adressé) Message libre d'un **joueur ou d'un spectateur** (200 caractères, un par seconde). Vérifié avant tout envoi par `src/moderation.js` : numéro de téléphone (même en lettres, déguisé ou coupé sur plusieurs messages) → jamais diffusé, chat suspendu 24 h (`chat_suspensions`, seule écriture en base) ; lien ou e-mail → refusé ; insultes graves → `***`. Les 50 derniers messages de la partie restent en mémoire (`chat_historique` à l'arrivée) |
| `{t:'admin_partie', jeton, partie, n}` | (0.12.0) **Régie** (jeton d'un compte admin) : état en mémoire d'une partie (`game` + `seats` : pions, tour, dé, tours manqués), sans lecture en base. Réponse `{t:'admin_partie', n, partie, game, seats, v}` ou `{…, absent: true}` si personne n'est connecté à cette partie |
| `{t:'actualiser'}` | « J'ai changé la partie par Supabase » (rejoindre, revanche…) : le serveur relit et prévient la table |
| `{t:'admin_spectateurs', jeton, n}` | (0.9.0) **Régie** : jeton d'un compte admin (vérifié une fois par `_serveur_est_admin`, gardé 5 min) ; réponse `{t:'spectateurs', parties: {id: [{uid, pseudo}]}}`. Rien n'est écrit en base |
| `{t:'ping', c}` | Mesurer la latence |
| `{t:'session', jeton}` | **Ligne directe** (0.4.0) : identifie le joueur pour toute la durée de l'appli, hors partie |
| `{t:'en_ligne', ids, n}` | Parmi ces joueurs, lesquels ont l'appli ouverte ? |
| `{t:'visible', v}` | (0.10.0) **Ligne directe** : l'appli passe à l'écran (`true`) ou en arrière-plan (`false`). Toutes les 30 s, le serveur note la présence (« vu il y a… », salle d'attente) des joueurs à l'écran en une seule requête (`_serveur_presence`, `sql/07_serveur_presence.sql`) ; `session_ok` porte alors `presence: true` et l'appli cesse d'appeler `noter_vu` / `salle_present` |

Serveur → téléphone (ligne directe) : `session_ok`, `signaux` (liste de `[sujet, clé]` : `solde`, `notifications`, `amis`, `paiements`, `support`, `salon`, `tournoi`, `partie` — le téléphone relit alors la donnée par Supabase ; aucun contenu ne transite), `en_ligne`.

Serveur → téléphone (partie) : `bienvenue`, `refus`, `etat` (même forme que la réponse de `move_pawn` : `game` + `seats`), `reponse` (résultat de SON action), `emoji` (sticker envoyé à la table), `presence` (qui est connecté à la table ; `spectateurs` : nombre de personnes qui regardent), `chat` (message : `id`, `de`, `pseudo`, `texte`, `spect`, `cible`, `a`), `chat_historique` (à l'arrivée), `chat_refus` (à l'auteur seulement : `raison` numero|lien|trop_vite|suspendu, `suspension`, `jusqua`), `reaction` (réaction d'un spectateur : `code`, `id`, `de`, `pseudo` lu en base une fois par connexion via `_serveur_pseudo`, `cible`), `pong`. L'état d'une partie terminée contient aussi `revanche` (revanche en cours et joueurs déjà assis).

**Protocole 2 (0.5.0)** : chaque état porte une version `v` et l'époque du serveur `ep` (tirée au démarrage). Aux téléphones qui l'annoncent, le serveur envoie `maj` au lieu de `etat` : `{t:'maj', ep, de, v, d}` où `d` ne contient que ce qui a changé depuis la version `de` (`g` champs de la partie, `s` champs des sièges par joueur, `S` tous les sièges si quelqu'un arrive ou part, `r` revanche). Voir `src/delta.js`. Une différence vide (`de === v`) accompagne une action sans changement. Les 40 derniers états de chaque partie sont gardés pour les reprises ; au-delà (ou après un redémarrage), l'état complet est renvoyé. Les messages sont compressés (permessage-deflate). Les anciennes versions du jeu reçoivent toujours `etat`. Sur une partie complète : environ 1 300 octets par mise à jour avant, 50 après.

## Réglages (variables d'environnement)

Voir le haut de `src/index.js`. Les valeurs secrètes (`DATABASE_URL`) vont **uniquement** dans `/etc/ludomiza/serveur.env` sur le VPS, jamais dans ce dépôt.

## Tests

`npm test` : parties complètes jouées par des robots sur une **copie locale** de la base (voir `test/LISEZ-MOI.md`), chronomètres, droits, sécurité, 20 parties simultanées.
