# Build from the repository root: docker build -f server/Dockerfile .
FROM oven/bun:1.4.2 AS bun

FROM node:25-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @starbridge/server...
COPY packages/protocol packages/protocol
COPY server server
RUN bun build server/src/main.ts --target bun --outfile /out/server.js

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /out/server.js .
RUN mkdir /data && chown bun:bun /data
USER bun
ENV PORT=8080 DB_PATH=/data/starbridge.db
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "server.js"]
