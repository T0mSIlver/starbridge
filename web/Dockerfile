# Build from the repository root: docker build -f web/Dockerfile .
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at package.json's packageManager version; node images no longer all ship corepack.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
COPY packages/protocol/package.json packages/protocol/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @starbridge/web...
# What the image ships, with its licence texts (scripts/licenses/licenses.ts, #2024).
COPY scripts/licenses/licenses.ts scripts/licenses/licenses.ts
RUN mkdir -p /out && bun scripts/licenses/licenses.ts notices npm @starbridge/web > /out/THIRD-PARTY-NOTICES.txt
COPY packages/protocol packages/protocol
COPY web web
# Served at /install.sh and /install.ps1 (web/src/app/install.*/route.ts).
COPY cli/install.sh cli/install.ps1 cli/
# Rendered under /docs at build time (web/src/lib/docs.ts).
COPY docs docs
COPY cli/README.md cli/README.md
COPY server/README.md server/README.md
# Caddy routes /v1 to the server; the rewrite only serves a request that reaches here anyway.
ENV STARBRIDGE_SERVER=http://127.0.0.1:8080 NEXT_TELEMETRY_DISABLED=1
# "umami" loads Umami's script on the public pages; only starbridge.run's compose file sets it.
ARG ANALYTICS=
ENV NEXT_PUBLIC_ANALYTICS=$ANALYTICS
RUN cd web && bun run build

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
WORKDIR /app
COPY --from=build /src/web/.next/standalone ./
COPY --from=build /src/web/.next/static web/.next/static
COPY --from=build /src/web/public web/public
COPY --from=build /out/THIRD-PARTY-NOTICES.txt ./
# As in server/Dockerfile: Debian's fixes, never from the build cache. npm and corepack go: the
# server runs on node alone, and their dependencies' vulnerabilities would fail scan.yml.
ARG REVISION=unknown
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "web/server.js"]
