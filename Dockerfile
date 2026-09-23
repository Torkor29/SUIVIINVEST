# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Image de production SuiviInvest — multi-étapes.
#
# Étape 1 : build du frontend (Vite -> fichiers statiques).
# Étape 2 : runtime Node minimal, utilisateur non privilégié, sans outillage.
#
# Aucune dépendance native n'est compilée (SQLite vient de `node:sqlite`), donc
# le build est reproductible et l'image finale reste petite.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --no-audit --no-fund
RUN npm run build --workspace @suiviinvest/web

# ---------------------------------------------------------------------------
# Étape 2 : sidecars Python (DEGIRO, Trade Republic) dans un venv isolé.
# Désactivable : docker compose build --build-arg WITH_SIDECARS=false
FROM node:24-bookworm-slim AS sidecars
ARG WITH_SIDECARS=true
RUN mkdir -p /opt/sidecar-venv \
 && if [ "$WITH_SIDECARS" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-venv \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY sidecar/requirements.txt /tmp/requirements.txt
RUN if [ "$WITH_SIDECARS" = "true" ]; then \
      python3 -m venv /opt/sidecar-venv \
      && /opt/sidecar-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt; \
    fi

# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ARG WITH_SIDECARS=true

ENV NODE_ENV=production \
    SUIVIINVEST_HOST=0.0.0.0 \
    SUIVIINVEST_PORT=9123 \
    SUIVIINVEST_DB=/data/suiviinvest.db \
    SUIVIINVEST_BACKUP_DIR=/backups \
    SUIVIINVEST_WEB_DIR=/app/web \
    SUIVIINVEST_LOG_LEVEL=info

# Python pour les sidecars (même version que le venv de l'étape « sidecars »).
RUN if [ "$WITH_SIDECARS" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Utilisateur non privilégié : l'application n'a besoin d'écrire que dans /data
# et /backups, montés en volumes.
RUN groupadd --system --gid 10001 suiviinvest \
 && useradd --system --uid 10001 --gid suiviinvest --home /app suiviinvest \
 && mkdir -p /data /backups /app \
 && chown -R suiviinvest:suiviinvest /data /backups /app

WORKDIR /app
COPY --chown=suiviinvest:suiviinvest package.json ./
COPY --chown=suiviinvest:suiviinvest packages ./packages
COPY --chown=suiviinvest:suiviinvest apps/api ./apps/api
COPY --from=build --chown=suiviinvest:suiviinvest /build/apps/web/dist ./web
COPY --chown=suiviinvest:suiviinvest sidecar ./sidecar
COPY --chown=suiviinvest:suiviinvest --chmod=0755 docker/entrypoint.sh ./docker/entrypoint.sh
COPY --from=sidecars /opt/sidecar-venv /opt/sidecar-venv

RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# HOME dans le volume de données (session Trade Republic persistante). Défini
# APRÈS l'installation npm pour que le cache de build n'y soit pas écrit.
ENV HOME=/data/home

USER suiviinvest
EXPOSE 9123

# Sonde de santé : elle échoue si la base n'est pas lisible ou les migrations KO.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SUIVIINVEST_PORT||9123)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Point d'entrée : branche les sidecars Python s'ils sont présents, puis lance
# le backend (TypeScript exécuté directement, type stripping natif Node 24+).
ENTRYPOINT ["/app/docker/entrypoint.sh"]
