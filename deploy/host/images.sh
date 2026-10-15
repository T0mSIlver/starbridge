#!/bin/sh
# images.sh: run as root by host/apply.sh and staging/apply.sh with REVISION set. Makes sure the
# box holds the server and web images of that commit, tagged by it, and prints one line per image,
# `server sha256:…` and `web sha256:…`: the digest the deploy runs, which apply.sh pins in
# deploy/.env.
#
# With SERVER_DIGEST and WEB_DIGEST set, those digests are the images (#1715): starbridge-deploy
# passes the ones staging ran, so prod runs the bytes staging passed even if the tag was pushed
# again since. Without them (staging, and deploy.sh, the owner's), the tag names the images: the
# box's copy, else the registry's.
set -eu
case ${REVISION:-} in *[!0-9a-f]*) REVISION= ;; esac
[ ${#REVISION} -eq 40 ] || { echo "images.sh: REVISION is not a commit id" >&2; exit 1; }
for image in server web; do
  name=ghcr.io/t0msilver/starbridge-$image
  case $image in server) digest=${SERVER_DIGEST:-} ;; *) digest=${WEB_DIGEST:-} ;; esac
  if [ -n "$digest" ]; then
    case ${digest#sha256:} in *[!0-9a-f]*) digest= ;; esac
    [ ${#digest} -eq 71 ] || { echo "images.sh: not a sha256 digest for $image" >&2; exit 1; }
    # Tagged by commit too, which rollback.sh and the cleanup below apply.sh read.
    docker image inspect "$name@$digest" >/dev/null 2>&1 || docker pull -q "$name@$digest" >/dev/null
    docker tag "$name@$digest" "$name:$REVISION"
  else
    docker image inspect "$name:$REVISION" >/dev/null 2>&1 || docker pull -q "$name:$REVISION" >/dev/null
    # The registry's digest of the multi-architecture image, which Docker keeps for what it pulled.
    digest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$name:$REVISION" |
      sed -n "s|^$name@\(sha256:[0-9a-f]\{64\}\)$|\1|p")
    [ "$(printf '%s\n' "$digest" | grep -c .)" -eq 1 ] ||
      { echo "images.sh: $name:$REVISION has no single registry digest" >&2; exit 1; }
  fi
  echo "$image $digest"
done
