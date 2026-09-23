#!/usr/bin/env bash
# Installation / mise à jour de SuiviInvest sur votre serveur (à lancer en SSH,
# depuis Termius par exemple), dans le dossier du dépôt :
#
#   ./scripts/install-server.sh                      # installation ou mise à jour
#   ./scripts/install-server.sh https://patrimoine.mondomaine.fr   # + adresse publique
#
# Pour une mise à jour depuis GitHub, préférez ./scripts/update.sh.
#
# Ce que fait le script :
#   1. crée `.env` s'il n'existe pas, avec une clé maîtresse aléatoire (jamais
#      écrasée ensuite : la perdre rendrait vos identifiants et sauvegardes
#      illisibles) ;
#   2. restreint les droits de `.env` (lecture par vous seul) ;
#   3. construit et (re)démarre le conteneur, puis vérifie qu'il répond.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker n'est pas installé : voir la section « Déploiement » du README." >&2
  exit 1
fi

# Accès à Docker : directement si l'utilisateur est dans le groupe « docker »,
# sinon via sudo (sans mot de passe interactif pour les mises à jour automatiques).
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -t 0 ] || sudo -n true 2>/dev/null; then
    DOCKER="sudo docker"
  else
    echo "Pas d'accès à Docker. Une fois pour toutes : sudo usermod -aG docker \$USER (puis reconnectez-vous)." >&2
    exit 1
  fi
fi

PUBLIC_URL="${1:-}"

if [ ! -f .env ]; then
  cp .env.example .env
  KEY="$(openssl rand -base64 48 | tr -d '\n')"
  # Remplace la ligne vide SUIVIINVEST_MASTER_KEY= par la clé générée.
  sed -i "s|^SUIVIINVEST_MASTER_KEY=.*$|SUIVIINVEST_MASTER_KEY=${KEY}|" .env
  echo "✔ .env créé avec une clé maîtresse neuve."
  echo
  echo "  ⚠️  Copiez MAINTENANT cette clé dans votre gestionnaire de mots de passe :"
  echo "      ${KEY}"
  echo "      Sans elle, les identifiants de vos banques et vos sauvegardes chiffrées"
  echo "      sont irrécupérables."
  echo
else
  echo "✔ .env existant conservé (clé maîtresse inchangée)."
fi

if [ -n "$PUBLIC_URL" ]; then
  if grep -q '^SUIVIINVEST_PUBLIC_URL=' .env; then
    sed -i "s|^SUIVIINVEST_PUBLIC_URL=.*$|SUIVIINVEST_PUBLIC_URL=${PUBLIC_URL%/}|" .env
  else
    echo "SUIVIINVEST_PUBLIC_URL=${PUBLIC_URL%/}" >> .env
  fi
  echo "✔ Adresse publique : ${PUBLIC_URL%/}"
  # Adresse HTTPS (Cloudflare, reverse proxy) : cookies « Secure » et en-têtes
  # du proxy pris en compte.
  case "$PUBLIC_URL" in
    https://*)
      for VAR in SUIVIINVEST_COOKIE_SECURE SUIVIINVEST_TRUST_PROXY; do
        if grep -q "^${VAR}=" .env; then
          sed -i "s|^${VAR}=.*$|${VAR}=true|" .env
        else
          echo "${VAR}=true" >> .env
        fi
      done
      ;;
  esac
fi

chmod 600 .env

if ! grep -q '^SUIVIINVEST_MASTER_KEY=.\{32,\}' .env; then
  echo "SUIVIINVEST_MASTER_KEY absente ou trop courte dans .env : corrigez-la avant de continuer." >&2
  exit 1
fi

$DOCKER compose build
$DOCKER compose up -d

echo -n "Démarrage"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9123/health >/dev/null 2>&1; then
    echo
    echo "✔ SuiviInvest répond sur http://127.0.0.1:9123 (ouvrez-le via votre nom de domaine HTTPS)."
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo
echo "Le service ne répond pas encore : $DOCKER compose logs -f suiviinvest" >&2
exit 1
