# Build from the repository root: docker build -f web/Dockerfile .
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at package.json's packageManager version; node images no longer all ship corepack.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
COPY packages/protocol/package.json packages/protocol/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @starbridge/web...
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

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
WORKDIR /app
COPY --from=build /src/web/.next/standalone ./
COPY --from=build /src/web/.next/static web/.next/static
COPY --from=build /src/web/public web/public
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "web/server.js"]
