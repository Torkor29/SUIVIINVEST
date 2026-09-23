#!/bin/sh
# Point d'entrée du conteneur SuiviInvest.
#
# - HOME est placé dans le volume /data : la session Trade Republic validée
#   (cookie écrit par pytr) survit aux redémarrages et aux mises à jour ;
# - les sidecars DEGIRO / Trade Republic sont branchés automatiquement quand
#   l'image contient Python (build par défaut). Une valeur fournie dans .env
#   reste prioritaire.
set -eu

mkdir -p "${HOME:-/data/home}"

PYTHON=/opt/sidecar-venv/bin/python
if [ -x "$PYTHON" ]; then
  : "${SUIVIINVEST_SIDECAR_DEGIRO_COMMAND:=$PYTHON}"
  : "${SUIVIINVEST_SIDECAR_DEGIRO_ARGS:=[\"/app/sidecar/degiro/sidecar.py\"]}"
  : "${SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND:=$PYTHON}"
  : "${SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_ARGS:=[\"/app/sidecar/trade-republic/sidecar.py\"]}"
  : "${SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_TIMEOUT_MS:=150000}"
  export SUIVIINVEST_SIDECAR_DEGIRO_COMMAND SUIVIINVEST_SIDECAR_DEGIRO_ARGS \
    SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_ARGS \
    SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_TIMEOUT_MS
fi

exec node apps/api/src/server.ts "$@"
