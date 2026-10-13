# The rehearsal's own tools (rehearse.sh): Bun for the scripts, pnpm for packages/protocol's
# dependencies, the same versions the images build with.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:26-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ARG PNPM=pnpm@11.25.0
RUN npm install -g --silent "$PNPM"
