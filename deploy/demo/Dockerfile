# The demo server for Play reviewers (#423): the server and the demo program in one image.
# Build from the repository root: docker build -f deploy/demo/Dockerfile .
FROM oven/bun:1.4.2 AS bun

FROM node:24-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY cli/package.json cli/
COPY demo/package.json demo/
RUN pnpm install --frozen-lockfile --filter @starbridge/demo... --filter @starbridge/server... --filter starbridge...
COPY packages/protocol packages/protocol
COPY server server
COPY cli cli
COPY plugin/skills plugin/skills
COPY demo demo
RUN bun build server/src/main.ts --target bun --outfile /out/server.js \
 && bun build cli/src/main.ts --target bun --outfile /out/starbridge.js \
 && bun build demo/src/main.ts --target bun --outfile /out/demo.js \
 && bun build demo/src/codexbar.ts --target bun --outfile /out/codexbar.js

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /out/ ./
COPY deploy/demo/start.sh deploy/demo/codexbar ./
USER bun
# The database lives in /tmp, a tmpfs in compose.yaml: each start is a fresh account.
ENV PORT=8080 DB_PATH=/tmp/demo/starbridge.db DEMO=1 DEMO_DIR=/tmp/demo/machine
EXPOSE 8080
CMD ["/app/start.sh"]
