# syntax=docker/dockerfile:1

# ---- Build stage: install production dependencies only -----------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Copied separately so the dependency layer is cached until the manifests change.
COPY package.json package-lock.json .npmrc ./

RUN npm ci --omit=dev


# ---- Runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM to node, so the graceful shutdown
# handler in server.js actually receives the signal.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json ./
COPY server.js app.js ./
COPY config ./config
COPY lib ./lib
COPY services ./services
COPY uploads ./uploads

# Drop privileges: the image ships with an unprivileged `node` user.
USER node

EXPOSE 3000

# Container-level liveness. Compose and orchestrators can also probe /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
