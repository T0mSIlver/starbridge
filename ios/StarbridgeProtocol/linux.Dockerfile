# The Linux toolchain ios.yml tests StarbridgeProtocol in, with the system libsodium. A Dockerfile
# rather than the job's container, so Dependabot updates the pinned image.
FROM swift:6.4.3@sha256:e0f67c4120502628d4ced5058df25d334332e21501ae1a0797fd0c0a96486e79
RUN apt-get update -qq && apt-get install -qq -y libsodium-dev pkg-config && rm -rf /var/lib/apt/lists/*
