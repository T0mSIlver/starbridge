# Caddy with the rate_limit handler, which stock Caddy lacks, for Umami's public collect endpoint
# (Caddyfile). The module is pinned to a commit; it has no recent release tag. Caddy's version is
# pinned too: a new image recreates the container, which drops every open connection, so it
# changes only when this file does.
FROM caddy:2.11.7-builder AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.7
COPY --from=build /usr/bin/caddy /usr/bin/caddy
