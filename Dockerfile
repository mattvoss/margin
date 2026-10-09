# syntax=docker/dockerfile:1
# Margin — single-process TanStack Start image (Linux only).
# UI + /api/* served by Nitro node-server on :3000. Data lives in /data.

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
# routeTree.gen.ts is committed by dev runs; regenerate to be safe
RUN npx --yes @tanstack/router-plugin --help >/dev/null 2>&1 || true
RUN npm run build

FROM node:22-bookworm-slim AS run
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/* \
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/.output ./.output
COPY prompts ./prompts
COPY sample-workspace ./sample-workspace
COPY docker/entry.sh ./entry.sh
RUN chmod +x ./entry.sh
ENV NODE_ENV=production \
    PORT=3000 \
    MARGIN_DATA_DIR=/data \
    MARGIN_PROMPTS_DIR=/app/prompts

# ============================================================
# OpenCode
# ============================================================
RUN npm install -g @opencode/cli

# ============================================================
# Pi      
# ============================================================
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["./entry.sh"]
