# =============================================================================
# Lake Effect Helm — production image
#
# One image, two entry points: the web tier (`next start` over the standalone
# build) and the background worker (a single bundled file). They share a build
# so a deployment cannot end up running a worker from a different commit than
# the web tier — which, with migrations in the mix, is how a "mysterious"
# outage starts.
#
# The runtime stage carries the traced server output and nothing else. No
# TypeScript, no test runner, no build toolchain, no source tree. This process
# holds decrypted client credentials in memory; everything in the image is
# attack surface around them.
# =============================================================================

# -----------------------------------------------------------------------------
# deps — install once, cached on the lockfile alone
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: a build that silently resolves a different dependency tree
# than the one that was reviewed is not a reproducible build.
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# deps-prod — dependencies only, for the migrate stage
#
# The migrate image holds SUPERUSER database credentials, so what it carries is
# a security question rather than a size one. A full install puts vitest,
# drizzle-kit, typescript, esbuild and every @types package next to those
# credentials — 105 packages that exist to build and test the product, not to
# run it, and two of which currently carry advisories.
#
# `tsx` is a production dependency for exactly this reason: the migrate, bootstrap
# and key-rotation entry points are TypeScript executed directly, so tsx is not
# build tooling here, it is the runtime.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps-prod
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# -----------------------------------------------------------------------------
# builder — Next standalone output plus the bundled worker
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next reads NODE_ENV at build time; the routes are all force-dynamic, so
# nothing is prerendered and no database connection is needed to build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build && pnpm build:worker

# -----------------------------------------------------------------------------
# runtime — the web tier and the worker
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# A fixed uid, because it is not an implementation detail: the master key file
# on the host must be readable by exactly this user and by nobody else, and
# Helm refuses to start from a key file that is group- or world-readable. The
# setup guide and deploy/init-secrets.sh both chown to 10001.
RUN addgroup -g 10001 -S helm && adduser -u 10001 -S helm -G helm

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone server, its traced dependencies, and the static assets.
COPY --from=builder --chown=helm:helm /app/.next/standalone ./
COPY --from=builder --chown=helm:helm /app/.next/static ./.next/static
# public/ holds no secrets and is currently near-empty, but Next serves it
# verbatim — keep it in the image so a favicon added later needs no Dockerfile
# change.
COPY --from=builder --chown=helm:helm /app/public ./public

# The worker bundle and the one runtime dependency deliberately left external to
# it: postgres.js resolves its own protocol modules at run time and does not
# survive bundling.
COPY --from=builder --chown=helm:helm /app/dist/worker.mjs ./dist/worker.mjs
COPY --from=builder --chown=helm:helm /app/node_modules/postgres ./node_modules/postgres

# Writable state. Declared here so the directories exist with the right owner
# even when an operator forgets to mount a volume — the failure is then "no
# volume mounted" rather than "EACCES at 3am".
RUN mkdir -p /var/lib/helm/exports /var/lib/helm/passphrases /var/lib/helm/anchors /var/lib/helm/documents \
 && chown -R helm:helm /var/lib/helm \
 && chmod 0700 /var/lib/helm/exports /var/lib/helm/passphrases /var/lib/helm/documents

USER helm
EXPOSE 3000

# The health endpoint is public and says almost nothing — "ok" plus a database
# reachability flag. That is what a health check needs and all it should get.
#
# It checks the FLAG, not the status code. /api/health answers 200 with
# {"status":"degraded"} when the database is unreachable, so a check that
# stopped at `r.ok` would report this container healthy while it could not
# render a single page.
#
# docker-compose.yml overrides this for the `web` service; it stays here so the
# image behaves sensibly when run outside compose, and so the two do not
# disagree about what "healthy" means.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# -----------------------------------------------------------------------------
# migrate — one-shot, used only by the migrate service
#
# Separate from the runtime stage because it needs tsx and the SQL files, and
# the web tier and worker must not carry either. It runs as a superuser — see
# db/migrate.ts for why that is required rather than lax — and exits.
#
# Dependencies come from deps-prod, NOT deps: this image must not carry the test
# runner and the build toolchain alongside superuser credentials.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS migrate
WORKDIR /app

RUN addgroup -g 10001 -S helm && adduser -u 10001 -S helm -G helm

COPY --from=deps-prod --chown=helm:helm /app/node_modules ./node_modules
COPY --chown=helm:helm package.json pnpm-lock.yaml tsconfig.json ./
COPY --chown=helm:helm db ./db
COPY --chown=helm:helm scripts ./scripts
COPY --chown=helm:helm src ./src

USER helm
ENV NODE_ENV=production
CMD ["node_modules/.bin/tsx", "db/migrate.ts"]
