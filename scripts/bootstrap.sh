#!/usr/bin/env bash
# Installation de SuiviInvest depuis GitHub, en une commande (à lancer en SSH) :
#
#   curl -fsSL https://raw.githubusercontent.com/Torkor29/SUIVIINVEST/main/scripts/bootstrap.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Torkor29/SUIVIINVEST/main/scripts/bootstrap.sh | bash -s -- https://mon-adresse.trycloudflare.com
#
# - Dossier absent : clone du dépôt dans /opt/suiviinvest.
# - Dossier déjà cloné depuis GitHub : simple mise à jour.
# - Dossier copié à la main (pas un dépôt git) : clone à côté, reprise du .env
#   (clé maîtresse comprise), l'ancien dossier est conservé en « .old-<date> ».
#
# Les données (base, sauvegardes) sont dans les volumes Docker : jamais touchées.
set -euo pipefail

REPO_URL="${SUIVIINVEST_REPO:-https://github.com/Torkor29/SUIVIINVEST.git}"
TARGET="${SUIVIINVEST_DIR:-/opt/suiviinvest}"
PUBLIC_URL="${1:-}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

if [ -d "$TARGET/.git" ]; then
  echo "✔ $TARGET est déjà relié à GitHub : mise à jour."
  exec "$TARGET/scripts/update.sh" ${PUBLIC_URL:+"$PUBLIC_URL"}
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
NEW="${TARGET}.new-${STAMP}"
echo "→ Téléchargement du code depuis GitHub…"
$SUDO git clone --branch main "$REPO_URL" "$NEW"
$SUDO chown -R "$(id -u):$(id -g)" "$NEW"

if [ -d "$TARGET" ]; then
  if [ -f "$TARGET/.env" ]; then
    $SUDO cp "$TARGET/.env" "$NEW/.env"
    $SUDO chown "$(id -u):$(id -g)" "$NEW/.env"
    echo "✔ .env existant repris (clé maîtresse conservée)."
  fi
  $SUDO mv "$TARGET" "${TARGET}.old-${STAMP}"
  echo "✔ Ancien dossier conservé : ${TARGET}.old-${STAMP}"
fi
$SUDO mv "$NEW" "$TARGET"

cd "$TARGET"
exec ./scripts/install-server.sh ${PUBLIC_URL:+"$PUBLIC_URL"}
