# Tests

Les tests utilisent un Postgres 17 **local et jetable** (jamais la vraie base).

`test/sql/00_base_locale.sql` recopie la partie « jeu » de la base de production
(tables, déclencheurs, fonctions de jeu, droits), telle qu'elle était le 30/09/2026.
Si les fonctions de jeu changent dans Supabase, il faut mettre ce fichier à jour.

Chaque lancement crée une base `ludotest_xxxx`, y charge ce fichier puis
`sql/01_serveur_jeu.sql`, et la supprime à la fin.

Adresse du Postgres local : `PG_TEST_URL`
(par défaut `postgres://postgres@127.0.0.1:54329/postgres`).

Les tournois ne sont pas reproduits dans la copie locale.
