# The Linux toolchain ios.yml tests StarbridgeProtocol in, with the system libsodium. A Dockerfile
# rather than the job's container, so Dependabot updates the pinned image.
FROM swift:6.4.0@sha256:4601bf61dab9485a3e93087770b72d268737e945a5b000e2286b6cc48bb048b6
RUN apt-get update -qq && apt-get install -qq -y libsodium-dev pkg-config && rm -rf /var/lib/apt/lists/*
