# Magnolia — one image, two entrypoints (api, worker).
#
# One image rather than two because the apps share the whole workspace: every package under
# packages/ is a dependency of both, so separate images would duplicate the build and then have
# to be kept in step. Which process runs is a matter of CMD, not of what was built.
#
# TypeScript is NOT compiled to JavaScript here; it runs under `tsx`. `tsc` still runs in CI as a
# typechecker, which is what it is for.
#
# `tsx` specifically, NOT `node --experimental-strip-types`. The workspace uses NodeNext `.js`
# import specifiers (`./ingest/ingest-worker.js` resolving to a `.ts` file), which is what tsc
# requires — and Node's native type stripping does not rewrite that specifier back to `.ts`, so
# it dies with ERR_MODULE_NOT_FOUND on the first relative import. tsx resolves it. This was found
# by running the container command rather than reading it.
#
# tsx is therefore a real dependency of both apps, not dev tooling.

# ─── deps ────────────────────────────────────────────────────────────────────────────────
# Separate stage so a source-only change does not re-resolve the dependency tree.
FROM node:22-bookworm-slim AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY apps/worker/package.json        apps/worker/
COPY packages/compliance/package.json packages/compliance/
COPY packages/config/package.json    packages/config/
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY packages/providers/package.json packages/providers/
COPY packages/testkit/package.json   packages/testkit/

# --frozen-lockfile: a lockfile that does not match the manifests should fail the build rather
# than silently resolve to something nobody tested.
RUN pnpm install --frozen-lockfile --prod=false

# ─── runtime ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# tini reaps zombies and, more importantly here, forwards SIGTERM to the Node process. Without
# an init, PID 1 is node itself, which is fine — but under a shell-form CMD the signal reaches
# the shell instead and the graceful shutdown in main.ts never runs. Both entrypoints below use
# exec form, and tini makes that robust regardless.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY . .

# Run unprivileged. The node image ships a `node` user; nothing here needs root, and the
# container writes nothing to disk outside /tmp.
RUN chown -R node:node /app
USER node

# Recorded into /health so a rolling deploy can be watched replica by replica.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

ENTRYPOINT ["/usr/bin/tini", "--"]

# Default to the API; docker-compose overrides this for the worker.
CMD ["pnpm", "--filter", "@magnolia/api", "start"]
