# The Linux toolchain ios.yml tests StarbridgeProtocol in, with the system libsodium. A Dockerfile
# rather than the job's container, so Dependabot updates the pinned image.
FROM swift:6.4.1@sha256:82152e9f18ee21fc997fd4580b93a14097e465cb10d7a7eee3f2dc85364dd135
RUN apt-get update -qq && apt-get install -qq -y libsodium-dev pkg-config && rm -rf /var/lib/apt/lists/*
