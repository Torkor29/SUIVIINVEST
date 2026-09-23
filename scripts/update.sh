#!/usr/bin/env bash
# Mise à jour depuis GitHub (branche main), puis reconstruction et redémarrage.
#
#   ./scripts/update.sh                         # mise à jour
#   ./scripts/update.sh https://nouvelle-adresse.trycloudflare.com
#   ./scripts/update.sh --auto                  # active la mise à jour automatique (toutes les 15 min)
#   ./scripts/update.sh --if-changed            # (utilisé par l'automatique) ne fait rien sans nouveau commit
#
# Le .env et les volumes Docker ne sont jamais modifiés par une mise à jour.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(pwd)"

if [ "${1:-}" = "--auto" ]; then
  LINE="*/15 * * * * $DIR/scripts/update.sh --if-changed >> $DIR/update.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "scripts/update.sh" ; echo "$LINE" ) | crontab -
  echo "✔ Mise à jour automatique activée : toutes les 15 minutes, depuis GitHub (journal : $DIR/update.log)."
  echo "  Pour l'arrêter : crontab -l | grep -v scripts/update.sh | crontab -"
  exit 0
fi

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"

if [ "${1:-}" = "--if-changed" ]; then
  if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi
  echo "[$(date -Iseconds)] nouvelle version ${REMOTE:0:7} (actuelle ${LOCAL:0:7})"
  shift
fi

# Le serveur suit exactement GitHub : aucune modification locale du code n'est
# conservée (le .env, ignoré par git, n'est pas concerné).
git reset --hard --quiet origin/main
echo "✔ Code à jour : $(git log -1 --format='%h %s')"

exec ./scripts/install-server.sh "$@"
