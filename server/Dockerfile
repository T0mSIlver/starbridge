# Build from the repository root: docker build -f server/Dockerfile .
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at package.json's packageManager version; node images no longer all ship corepack.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @starbridge/server...
COPY packages/protocol packages/protocol
COPY server server
RUN bun build server/src/main.ts --target bun --outfile /out/server.js

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
COPY --from=build /out/server.js .
RUN mkdir /data && chown bun:bun /data
USER bun
ARG REVISION=unknown
ENV PORT=8080 DB_PATH=/data/starbridge.db STARBRIDGE_REVISION=$REVISION
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "server.js"]
