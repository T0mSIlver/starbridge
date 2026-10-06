# The demo server for Play reviewers (#423): the server and the demo program in one image.
# Build from the repository root: docker build -f deploy/demo/Dockerfile .
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at package.json's packageManager version; node images no longer all ship corepack.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY cli/package.json cli/
COPY demo/package.json demo/
RUN pnpm install --frozen-lockfile --filter @starbridge/demo... --filter @starbridge/server... --filter starbridge...
COPY packages/protocol packages/protocol
COPY server server
COPY cli cli
COPY plugin plugin
COPY mod mod
COPY demo demo
RUN bun build server/src/main.ts --target bun --outfile /out/server.js \
 && bun build cli/src/main.ts --target bun --outfile /out/starbridge.js \
 && bun build demo/src/main.ts --target bun --outfile /out/demo.js \
 && bun build demo/src/codexbar.ts --target bun --outfile /out/codexbar.js

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
COPY --from=build /out/ ./
COPY deploy/demo/start.sh deploy/demo/codexbar ./
USER bun
# The database lives in /tmp, a tmpfs in compose.yaml: each start is a fresh account.
ENV PORT=8080 DB_PATH=/tmp/demo/starbridge.db DEMO=1 DEMO_DIR=/tmp/demo/machine
EXPOSE 8080
CMD ["/app/start.sh"]
