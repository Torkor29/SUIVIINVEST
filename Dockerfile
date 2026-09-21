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
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --no-audit --no-fund
RUN npm run build --workspace @suiviinvest/web

# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SUIVIINVEST_HOST=0.0.0.0 \
    SUIVIINVEST_PORT=9123 \
    SUIVIINVEST_DB=/data/suiviinvest.db \
    SUIVIINVEST_BACKUP_DIR=/backups \
    SUIVIINVEST_WEB_DIR=/app/web \
    SUIVIINVEST_LOG_LEVEL=info

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

RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

USER suiviinvest
EXPOSE 9123

# Sonde de santé : elle échoue si la base n'est pas lisible ou les migrations KO.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SUIVIINVEST_PORT||9123)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Le backend est exécuté en TypeScript directement (type stripping natif Node 24+).
CMD ["node", "apps/api/src/server.ts"]
