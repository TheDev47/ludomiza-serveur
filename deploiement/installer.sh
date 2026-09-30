#!/bin/bash
# ============================================================================
# Installation du serveur de jeu LudoMiza sur un VPS Ubuntu 24.04 neuf.
#
# À coller dans DigitalOcean > Create Droplet > « Startup scripts » (ou à
# lancer une fois en root). Il s'exécute tout seul au premier démarrage.
#
# Ce script ne contient AUCUN secret. La seule valeur secrète (l'adresse de
# connexion à la base, avec le mot de passe du rôle « serveur_jeu ») est
# ajoutée ensuite par Jordan dans /etc/ludomiza/serveur.env.
#
# Mises à jour : toutes les 2 minutes, le serveur regarde si la branche
# « main » du dépôt a changé ; si oui, il se met à jour et redémarre (les
# téléphones se reconnectent en moins d'une seconde).
# ============================================================================
set -euo pipefail
exec > >(tee -a /var/log/ludomiza-installation.log) 2>&1
echo "=== Installation LudoMiza : $(date -Is)"

DEPOT="https://github.com/TheDev47/ludomiza-serveur.git"
DOMAINE="jeu.ludomiza.com"
DOSSIER="/opt/ludomiza-serveur"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

# --- Node.js 22 -------------------------------------------------------------
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- Caddy (HTTPS automatique pour wss://jeu.ludomiza.com) -----------------
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- Utilisateur et code -----------------------------------------------------
id ludomiza >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin ludomiza
if [ ! -d "$DOSSIER/.git" ]; then
  git clone --depth 1 "$DEPOT" "$DOSSIER"
fi
chown -R ludomiza:ludomiza "$DOSSIER"
sudo -u ludomiza bash -c "cd $DOSSIER && npm ci --omit=dev"

# --- Configuration (sans secret ; DATABASE_URL à compléter par Jordan) ------
mkdir -p /etc/ludomiza
if [ ! -f /etc/ludomiza/serveur.env ]; then
  cat > /etc/ludomiza/serveur.env <<'EOF'
# Serveur de jeu LudoMiza — configuration
# SEULE LIGNE À COMPLÉTER : DATABASE_URL (voir LISEZ-MOI du dépôt, étape 3).
DATABASE_URL=
SUPABASE_URL=https://wfzrcmabqzcnajdilktc.supabase.co
SUPABASE_ANON_KEY=sb_publishable_A2dMyndeOX5m4lQpNm5zIA_6RirtWJN
PORT=8080
HOTE=127.0.0.1
ORIGINES=https://game.ludomiza.com,https://test.ludomiza.com,https://localhost,capacitor://localhost,http://localhost
TOUTES_LES_PARTIES=non
EOF
fi
chown root:ludomiza /etc/ludomiza/serveur.env
chmod 640 /etc/ludomiza/serveur.env

# --- Service -----------------------------------------------------------------
cat > /etc/systemd/system/ludomiza-serveur.service <<EOF
[Unit]
Description=LudoMiza - serveur de jeu
After=network-online.target
Wants=network-online.target

[Service]
User=ludomiza
WorkingDirectory=$DOSSIER
EnvironmentFile=/etc/ludomiza/serveur.env
# Tant que DATABASE_URL est vide, le service ne démarre pas (sans boucler).
ExecCondition=/bin/sh -c 'test -n "\$\$DATABASE_URL"'
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# --- Mise à jour automatique depuis GitHub (branche main) --------------------
cat > /usr/local/bin/ludomiza-maj <<EOF
#!/bin/bash
set -e
cd $DOSSIER
sudo -u ludomiza git fetch -q --depth 1 origin main
if [ "\$(sudo -u ludomiza git rev-parse HEAD)" != "\$(sudo -u ludomiza git rev-parse origin/main)" ]; then
  echo "Mise à jour vers \$(sudo -u ludomiza git rev-parse --short origin/main)"
  sudo -u ludomiza git reset -q --hard origin/main
  sudo -u ludomiza npm ci --omit=dev
  systemctl restart ludomiza-serveur
fi
EOF
chmod 755 /usr/local/bin/ludomiza-maj

cat > /etc/systemd/system/ludomiza-maj.service <<'EOF'
[Unit]
Description=LudoMiza - mise à jour du serveur de jeu
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ludomiza-maj
EOF
cat > /etc/systemd/system/ludomiza-maj.timer <<'EOF'
[Unit]
Description=LudoMiza - vérifier les mises à jour toutes les 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF

# --- Assistant de configuration : demande le mot de passe (caché) ----------
# (heredoc entre quotes : rien n'est remplacé à l'écriture du fichier)
cat > /usr/local/bin/ludomiza-configurer <<'FIN'
#!/bin/bash
# Relie le serveur de jeu à la base Supabase. À lancer par Jordan, en root.
set -e
echo "Hôte du « Session pooler » Supabase (bouton Connect, ex. aws-0-eu-west-3.pooler.supabase.com) :"
read -r HOTE_BD
echo "Mot de passe du rôle serveur_jeu (il ne s'affiche pas pendant la frappe) :"
read -rs MDP
echo
MDP_ENC=$(MDP="$MDP" node -e 'process.stdout.write(encodeURIComponent(process.env.MDP))')
URL="postgresql://serveur_jeu.wfzrcmabqzcnajdilktc:${MDP_ENC}@${HOTE_BD}:5432/postgres"
echo "Test de la connexion…"
cd /opt/ludomiza-serveur
if sudo -u ludomiza env DATABASE_URL="$URL" node -e '
  const pg = require("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  c.connect().then(() => c.query("select jsonb_array_length(public._serveur_etat(null, true)) as n"))
   .then((r) => { console.log("Connexion OK — parties en cours :", r.rows[0].n); return c.end(); })
   .catch((e) => { console.error("ÉCHEC :", e.message); process.exit(1); });'; then
  grep -v '^DATABASE_URL=' /etc/ludomiza/serveur.env > /etc/ludomiza/serveur.env.nouveau
  printf 'DATABASE_URL=%s\n' "$URL" >> /etc/ludomiza/serveur.env.nouveau
  chown root:ludomiza /etc/ludomiza/serveur.env.nouveau
  chmod 640 /etc/ludomiza/serveur.env.nouveau
  mv /etc/ludomiza/serveur.env.nouveau /etc/ludomiza/serveur.env
  systemctl restart ludomiza-serveur
  sleep 2
  curl -s http://127.0.0.1:8080/sante && echo
  echo "Serveur de jeu démarré."
else
  echo "Rien n'a été enregistré. Vérifiez l'hôte et le mot de passe, puis relancez : ludomiza-configurer"
fi
FIN
chmod 700 /usr/local/bin/ludomiza-configurer

# --- HTTPS (Caddy obtient le certificat tout seul dès que le DNS pointe ici) --
cat > /etc/caddy/Caddyfile <<EOF
$DOMAINE {
  reverse_proxy 127.0.0.1:8080
}
EOF

# --- Pare-feu : SSH, HTTP (certificat), HTTPS --------------------------------
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable --now ludomiza-maj.timer
systemctl enable ludomiza-serveur
systemctl restart caddy
systemctl start ludomiza-serveur || true

echo "=== Installation terminée : $(date -Is)"
echo "Reste à faire : lancer la commande  ludomiza-configurer  (mot de passe du rôle serveur_jeu)"
