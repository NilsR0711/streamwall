# syntax=docker/dockerfile:1
# Production image for streamwall-control-server (+ built control client).
# Build from repo root: docker build -f deploy/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages

# Full workspace install so local package links resolve (streamwall-shared, etc.).
RUN npm ci

# Static web control UI served by the control server.
RUN npm -w streamwall-control-client run build

FROM node:22-bookworm-slim AS run
WORKDIR /app

RUN groupadd --system streamwall \
  && useradd --system --gid streamwall --create-home --home-dir /data streamwall

COPY --from=build /app /app

ENV NODE_ENV=production \
    DB_PATH=/data/storage.json \
    STREAMWALL_CONTROL_HOSTNAME=0.0.0.0 \
    STREAMWALL_CONTROL_PORT=3000 \
    STREAMWALL_CONTROL_STATIC=/app/packages/streamwall-control-client/dist \
    STREAMWALL_TRUST_PROXY=true

USER streamwall
EXPOSE 3000
VOLUME ["/data"]

# Server runs TypeScript via the package's start script (tsx).
CMD ["npm", "-w", "streamwall-control-server", "start"]
