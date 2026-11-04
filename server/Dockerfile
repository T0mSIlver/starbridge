# Build from the repository root: docker build -f server/Dockerfile .
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at package.json's packageManager version; node images no longer all ship corepack.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @starbridge/server...
# What the image ships, with its licence texts (scripts/licenses/licenses.ts, #2024).
COPY scripts/licenses/licenses.ts scripts/licenses/licenses.ts
RUN mkdir -p /out && bun scripts/licenses/licenses.ts notices npm @starbridge/server > /out/THIRD-PARTY-NOTICES.txt
COPY packages/protocol packages/protocol
COPY server server
RUN bun build server/src/main.ts --target bun --outfile /out/server.js

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY --from=build /out/server.js .
COPY --from=build /out/THIRD-PARTY-NOTICES.txt ./
# Debian's fixes since the base image was published: scan.yml fails on a high or critical
# vulnerability that has one. REVISION differs on every commit, so this layer is never reused
# from the build cache.
ARG REVISION=unknown
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/* && mkdir /data && chown bun:bun /data
USER bun
ENV PORT=8080 DB_PATH=/data/starbridge.db STARBRIDGE_REVISION=$REVISION
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "server.js"]
