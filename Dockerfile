# ── Etage de compilation ─────────────────────────────────────────────
# better-sqlite3 est un module natif : les outils de compilation ne sont
# necessaires qu'ici, jamais dans l'image finale.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN npm run build && npm prune --omit=dev


# ── Image d'execution ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/scarpcrap.db

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY config ./config

# La base vit sur un volume monte par la plateforme d'hebergement. Le
# proprietaire de ce point de montage est impose par la plateforme (souvent
# root) : on reste root ici plutot que de risquer un EACCES au demarrage.
RUN mkdir -p /app/data

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini recolte les processus zombies et relaie proprement SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
