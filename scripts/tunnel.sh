#!/usr/bin/env bash
# Tunnel Cloudflare permanent : l'application devient accessible en HTTPS via une
# adresse « https://….trycloudflare.com », sans ouvrir de port sur le serveur.
#
#   ./scripts/tunnel.sh            # active le tunnel (ou le relance) et affiche l'adresse
#   ./scripts/tunnel.sh --url      # affiche seulement l'adresse en cours
#   ./scripts/tunnel.sh --off      # désactive le tunnel
#
# Le tunnel tourne dans un conteneur qui redémarre tout seul (même après un
# redémarrage du serveur). L'adresse temporaire change à chaque redémarrage du
# conteneur : relancez ce script pour la connaître et la mettre à jour dans .env.
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

current_url() {
  $DOCKER logs suiviinvest-tunnel 2>&1 | grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | tail -1
}

set_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" .env; then
    sed -i "s|^${name}=.*$|${name}=${value}|" .env
  else
    echo "${name}=${value}" >> .env
  fi
}

case "${1:-}" in
  --url)
    URL="$(current_url || true)"
    if [ -z "$URL" ]; then echo "Aucun tunnel actif : lancez ./scripts/tunnel.sh" >&2; exit 1; fi
    echo "$URL"
    exit 0
    ;;
  --off)
    $DOCKER compose --profile tunnel stop cloudflared || true
    $DOCKER compose --profile tunnel rm -f cloudflared || true
    sed -i '/^COMPOSE_PROFILES=/d' .env
    echo "✔ Tunnel désactivé."
    exit 0
    ;;
esac

if [ ! -f .env ]; then
  echo "Pas de .env : lancez d'abord ./scripts/install-server.sh" >&2
  exit 1
fi

# Le profil « tunnel » est mémorisé dans .env : les mises à jour le relancent.
set_env COMPOSE_PROFILES tunnel
$DOCKER compose up -d suiviinvest
$DOCKER compose --profile tunnel up -d --force-recreate cloudflared

echo -n "Ouverture du tunnel"
URL=""
for _ in $(seq 1 45); do
  URL="$(current_url || true)"
  if [ -n "$URL" ]; then break; fi
  echo -n "."
  sleep 2
done
echo

if [ -z "$URL" ]; then
  echo "Le tunnel ne donne pas d'adresse : $DOCKER logs suiviinvest-tunnel" >&2
  exit 1
fi

# Adresse HTTPS : cookies sécurisés, en-têtes du proxy pris en compte, liens
# « mot de passe oublié » construits sur cette adresse.
set_env SUIVIINVEST_PUBLIC_URL "$URL"
set_env SUIVIINVEST_COOKIE_SECURE true
set_env SUIVIINVEST_TRUST_PROXY true
chmod 600 .env
$DOCKER compose up -d suiviinvest >/dev/null

echo
echo "✔ Votre application : $URL"
echo "  (l'adresse s'affiche aussi avec : ./scripts/tunnel.sh --url)"
