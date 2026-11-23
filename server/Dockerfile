# Build from the repository root: docker build -f server/Dockerfile .
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
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

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643
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
