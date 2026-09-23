#!/usr/bin/env bash
# Tunnel Cloudflare permanent : l'application devient accessible en HTTPS via une
# adresse « https://….trycloudflare.com », sans ouvrir de port sur le serveur.
#
#   ./scripts/tunnel.sh            # active le tunnel et affiche l'adresse (sans la changer s'il tourne déjà)
#   ./scripts/tunnel.sh --url      # affiche seulement l'adresse en cours
#   ./scripts/tunnel.sh --new      # force une nouvelle adresse (si l'actuelle ne répond plus)
#   ./scripts/tunnel.sh --off      # désactive le tunnel
#
# Avec votre nom de domaine (adresse fixe, recommandé) :
#   ./scripts/tunnel.sh --domain https://patrimoine.mondomaine.fr --token <jeton du tunnel>
#   (jeton : Cloudflare → Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared ;
#    « Public hostname » : votre sous-domaine, service HTTP, URL suiviinvest:9123)
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
    if grep -q '^COMPOSE_PROFILES=tunnel-domain' .env 2>/dev/null; then
      grep '^SUIVIINVEST_PUBLIC_URL=' .env | cut -d= -f2-
      exit 0
    fi
    URL="$(current_url || true)"
    if [ -z "$URL" ]; then echo "Aucun tunnel actif : lancez ./scripts/tunnel.sh" >&2; exit 1; fi
    echo "$URL"
    exit 0
    ;;
  --off)
    $DOCKER compose --profile tunnel --profile tunnel-domain stop cloudflared cloudflared-domain || true
    $DOCKER compose --profile tunnel --profile tunnel-domain rm -f cloudflared cloudflared-domain || true
    sed -i '/^COMPOSE_PROFILES=/d' .env
    echo "✔ Tunnel désactivé."
    exit 0
    ;;
  --domain)
    DOMAIN_URL="${2:-}"
    TOKEN=""
    if [ "${3:-}" = "--token" ]; then TOKEN="${4:-}"; fi
    if ! echo "$DOMAIN_URL" | grep -qE '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
      echo "Usage : ./scripts/tunnel.sh --domain https://patrimoine.mondomaine.fr --token <jeton>" >&2
      exit 1
    fi
    if [ ! -f .env ]; then
      echo "Pas de .env : lancez d'abord ./scripts/install-server.sh" >&2
      exit 1
    fi
    if [ -n "$TOKEN" ]; then set_env CLOUDFLARE_TUNNEL_TOKEN "$TOKEN"; fi
    if ! grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.\+' .env; then
      echo "Jeton manquant : ajoutez --token <jeton du tunnel Cloudflare>" >&2
      exit 1
    fi
    # L'adresse temporaire n'est plus utile : son conteneur est arrêté.
    $DOCKER compose --profile tunnel stop cloudflared >/dev/null 2>&1 || true
    $DOCKER compose --profile tunnel rm -f cloudflared >/dev/null 2>&1 || true
    set_env COMPOSE_PROFILES tunnel-domain
    set_env SUIVIINVEST_PUBLIC_URL "$DOMAIN_URL"
    set_env SUIVIINVEST_COOKIE_SECURE true
    set_env SUIVIINVEST_TRUST_PROXY true
    chmod 600 .env
    $DOCKER compose up -d suiviinvest
    $DOCKER compose --profile tunnel-domain up -d --force-recreate cloudflared-domain
    echo -n "Connexion du tunnel"
    for _ in $(seq 1 30); do
      if $DOCKER logs suiviinvest-tunnel-domain 2>&1 | grep -q 'Registered tunnel connection'; then break; fi
      echo -n "."
      sleep 2
    done
    echo
    if ! $DOCKER logs suiviinvest-tunnel-domain 2>&1 | grep -q 'Registered tunnel connection'; then
      echo "Le tunnel ne se connecte pas (jeton invalide ?) : $DOCKER logs suiviinvest-tunnel-domain" >&2
      exit 1
    fi
    echo "✔ Votre application : $DOMAIN_URL"
    echo "  Adresse de retour Enable Banking : $DOMAIN_URL/connexions/banque"
    exit 0
    ;;
esac

if grep -q '^COMPOSE_PROFILES=tunnel-domain' .env 2>/dev/null && [ "${1:-}" != "--new" ]; then
  echo "✔ Tunnel sur votre domaine : $(grep '^SUIVIINVEST_PUBLIC_URL=' .env | cut -d= -f2-)"
  exit 0
fi

if [ ! -f .env ]; then
  echo "Pas de .env : lancez d'abord ./scripts/install-server.sh" >&2
  exit 1
fi

# Tunnel déjà actif : on garde son adresse (la changer casserait les pages
# ouvertes avec l'ancienne, qui répondraient « HTTP 530 »).
RUNNING="$($DOCKER inspect -f '{{.State.Running}}' suiviinvest-tunnel 2>/dev/null || echo false)"
if [ "${1:-}" != "--new" ] && [ "$RUNNING" = "true" ]; then
  URL="$(current_url || true)"
  if [ -n "$URL" ]; then
    set_env SUIVIINVEST_PUBLIC_URL "$URL"
    echo "✔ Tunnel déjà actif, adresse inchangée : $URL"
    echo "  (nouvelle adresse seulement si celle-ci ne répond plus : ./scripts/tunnel.sh --new)"
    exit 0
  fi
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
$DOCKER compose up -d suiviinvest >/dev/null 2>&1

# Attendre que l'application réponde de nouveau avant de donner l'adresse.
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9123/health >/dev/null 2>&1; then break; fi
  sleep 2
done

echo
echo "✔ Votre application : $URL"
echo "  (l'adresse s'affiche aussi avec : ./scripts/tunnel.sh --url)"
