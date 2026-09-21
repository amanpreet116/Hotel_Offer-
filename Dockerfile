# syntax=docker/dockerfile:1
#
# One image, two entrypoints: compose overrides `command` to run either the
# Express API or the Temporal worker. They share every dependency, so building
# and shipping them separately would only add drift.
#
# Debian slim rather than Alpine on purpose: @temporalio/core-bridge is a
# native Rust addon whose prebuilt binaries target glibc.

# ---- deps: production node_modules only ------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --no-audit/--fund keep the install quiet and quick; the retry settings make it
# resilient to a flaky network rather than failing the whole build.
RUN npm ci --omit=dev --no-audit --fund=false \
    --fetch-retries=5 --fetch-retry-maxtimeout=120000

# ---- build: full toolchain, compiles TypeScript to dist/ -------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --fund=false \
    --fetch-retries=5 --fetch-retry-maxtimeout=120000
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The worker bundles workflow code at startup and writes nothing to disk, so
# an unprivileged user is enough.
USER node

EXPOSE 3000

# Overridden by compose for the worker service.
CMD ["node", "dist/index.js"]
