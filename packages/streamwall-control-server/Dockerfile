# syntax=docker/dockerfile:1
#
# Build context must be the repository root (this is an npm workspaces
# monorepo, so `npm ci` needs the root lockfile and every workspace
# manifest). See deploy/docker-compose.yml or docs/self-hosting.md for the
# exact build invocation.

# ---- build ----------------------------------------------------------------
# Installs only the workspaces the control server needs (not the Electron
# app or the E2E suite) and builds the static web control client that the
# server serves at `/`.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/streamwall-shared/package.json packages/streamwall-shared/package.json
COPY packages/streamwall-control-server/package.json packages/streamwall-control-server/package.json
COPY packages/streamwall-control-client/package.json packages/streamwall-control-client/package.json
COPY packages/streamwall-control-ui/package.json packages/streamwall-control-ui/package.json

RUN npm ci \
  --workspace=streamwall-shared \
  --workspace=streamwall-control-server \
  --workspace=streamwall-control-client \
  --workspace=streamwall-control-ui \
  --include-workspace-root

COPY packages/streamwall-shared packages/streamwall-shared
COPY packages/streamwall-control-server packages/streamwall-control-server
COPY packages/streamwall-control-client packages/streamwall-control-client
COPY packages/streamwall-control-ui packages/streamwall-control-ui

RUN npm -w streamwall-control-client run build \
  && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
# No compile step for the server itself: it runs directly from `src/` via
# Node 22's native TypeScript support (see packages/streamwall-control-server
# /README.md). Runs as a non-root user; persistent data (auth tokens) lives
# on the /data volume.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN groupadd --system --gid 1001 streamwall \
  && useradd --system --uid 1001 --gid streamwall --home-dir /app --shell /usr/sbin/nologin streamwall \
  && mkdir -p /data \
  && chown -R streamwall:streamwall /data /app

COPY --from=build --chown=streamwall:streamwall /app/node_modules ./node_modules
COPY --from=build --chown=streamwall:streamwall /app/package.json ./package.json
COPY --from=build --chown=streamwall:streamwall /app/packages/streamwall-shared ./packages/streamwall-shared
COPY --from=build --chown=streamwall:streamwall /app/packages/streamwall-control-server ./packages/streamwall-control-server
COPY --from=build --chown=streamwall:streamwall /app/packages/streamwall-control-client/package.json ./packages/streamwall-control-client/package.json
COPY --from=build --chown=streamwall:streamwall /app/packages/streamwall-control-client/dist ./packages/streamwall-control-client/dist

USER streamwall

# Sane defaults for running in a container; override via `docker run -e` or
# docker-compose.yml / .env (see deploy/.env.example).
ENV STREAMWALL_CONTROL_HOSTNAME=0.0.0.0
ENV STREAMWALL_CONTROL_PORT=3000
ENV DB_PATH=/data/storage.json

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "packages/streamwall-control-server/src/index.ts"]
