# The demo server for Play reviewers (#423): the server and the demo program in one image.
# Build from the repository root: docker build -f deploy/demo/Dockerfile .
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
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
COPY .claude-plugin .claude-plugin
COPY plugin plugin
COPY mod mod
COPY demo demo
RUN bun build server/src/main.ts --target bun --outfile /out/server.js \
 && bun build cli/src/main.ts --target bun --outfile /out/starbridge.js \
 && bun build demo/src/main.ts --target bun --outfile /out/demo.js \
 && bun build demo/src/codexbar.ts --target bun --outfile /out/codexbar.js

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643
WORKDIR /app
COPY --from=build /out/ ./
COPY deploy/demo/start.sh deploy/demo/codexbar ./
# The database, the demo device's keys and the demo machine live in /data, a volume in
# compose.yaml, so the account outlasts restarts (#2049). A new volume takes this owner.
RUN install -d -o bun -g bun -m 700 /data
USER bun
ENV PORT=8080 DB_PATH=/data/starbridge.db DEMO=1 DEMO_DATA=/data
EXPOSE 8080
CMD ["/app/start.sh"]
