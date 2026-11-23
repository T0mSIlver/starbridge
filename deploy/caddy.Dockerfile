# Caddy with the rate_limit handler, which stock Caddy lacks, for Umami's public collect endpoint
# (Caddyfile). The module is pinned to a commit; it has no recent release tag. Caddy's version is
# pinned too: a new image recreates the container, which drops every open connection, so it
# changes only when this file does.
FROM caddy:2.11.8-builder@sha256:d4eb070c36154bd2d4c94b40359a03c6168346d5af5404963c74691ab77fb63f AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
COPY --from=build /usr/bin/caddy /usr/bin/caddy
