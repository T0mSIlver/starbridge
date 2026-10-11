# The Linux toolchain ios.yml tests StarbridgeProtocol in, with the system libsodium. A Dockerfile
# rather than the job's container, so Dependabot updates the pinned image.
FROM swift:6.3.3@sha256:cd45c27b3abc42310c33cfaf3008b18156cbdc9187834c9617e8f43a26d2675c
RUN apt-get update -qq && apt-get install -qq -y libsodium-dev pkg-config && rm -rf /var/lib/apt/lists/*
