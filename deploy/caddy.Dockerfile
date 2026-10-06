# Caddy with the rate_limit handler, which stock Caddy lacks, for Umami's public collect endpoint
# (Caddyfile). The module is pinned to a commit; it has no recent release tag. Caddy's version is
# pinned too: a new image recreates the container, which drops every open connection, so it
# changes only when this file does.
FROM caddy:2.11.7-builder@sha256:1ab914bd604996ab195f6326665cd2ae5d3df62feba973e776c4c8d5967d57a5 AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.7@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772
COPY --from=build /usr/bin/caddy /usr/bin/caddy
