FROM node:22.22.0-bookworm-slim AS build

ARG IMAGE_VERSION=dev

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=dev
ENV CI=0

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    && apt-get install -y --no-install-recommends libssl3 curl ca-certificates \
        cmake python3 python3.11 libpython3.11-dev gcc g++ make cmake openjdk-17-jdk-headless pkg-config libssl-dev clang libclang-dev \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

# 1.98.1 matches packages/cubejs-backend-native/rust-toolchain.toml. CubeStore uses nightly-2025-08-01,
# which is also used in the CI, so the binary is compatible with the official cube builds.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- --profile minimal --default-toolchain 1.98.1 -y \
    && rustup toolchain install nightly-2025-08-01 --profile minimal

ENV CUBESTORE_SKIP_POST_INSTALL=true
ENV NODE_ENV=development
# Use the image's Node headers to avoid concurrent node-gyp downloads and copies.
ENV npm_config_nodedir=/usr/local
# Only some workspaces are copied in, so the install has to prune yarn.lock; Yarn 4 would refuse
# whenever CI is set (even CI=0).
ENV YARN_ENABLE_IMMUTABLE_INSTALLS=false

WORKDIR /cubejs

COPY package.json .
COPY .yarnrc.yml .
COPY .yarn/releases .yarn/releases
COPY lerna.json .
COPY yarn.lock .
COPY tsconfig.base.json .
COPY rollup.config.js .
COPY packages/cubejs-linter packages/cubejs-linter

# Backend
COPY packages/cubejs-backend-shared/ packages/cubejs-backend-shared/
COPY packages/cubejs-base-driver/ packages/cubejs-base-driver/
COPY packages/cubejs-backend-native/ packages/cubejs-backend-native/
COPY packages/cubejs-testing-shared/ packages/cubejs-testing-shared/
COPY packages/cubejs-backend-cloud/ packages/cubejs-backend-cloud/
COPY packages/cubejs-api-gateway/ packages/cubejs-api-gateway/
COPY packages/cubejs-cli/ packages/cubejs-cli/
COPY packages/cubejs-cubestore-driver/ packages/cubejs-cubestore-driver/
COPY packages/cubejs-postgres-driver/ packages/cubejs-postgres-driver/
COPY packages/cubejs-query-orchestrator/ packages/cubejs-query-orchestrator/
COPY packages/cubejs-schema-compiler/ packages/cubejs-schema-compiler/
COPY packages/cubejs-server/ packages/cubejs-server/
COPY packages/cubejs-server-core/ packages/cubejs-server-core/
COPY packages/cubejs-event-emitter/ packages/cubejs-event-emitter/
COPY packages/cubejs-tracer/ packages/cubejs-tracer/
COPY packages/cubejs-templates/ packages/cubejs-templates/
# Build-only: schema-compiler's tsconfig references it for its tests; not part of the runtime image
COPY packages/cubejs-mssql-driver/ packages/cubejs-mssql-driver/

# Backend Rust components
COPY rust/cube/cubenativeutils/ rust/cube/cubenativeutils/
COPY rust/cube/cubeshared/ rust/cube/cubeshared/
COPY rust/cube/cubeorchestrator/ rust/cube/cubeorchestrator/
COPY rust/cube/cubesqlplanner/ rust/cube/cubesqlplanner/
COPY rust/cubestore/ rust/cubestore/
COPY rust/cubesql/ rust/cubesql/

RUN yarn install
RUN yarn lerna run build

# Compile @cubejs-backend/native from this checkout: the prebuilt binary that its post-install
# downloads doesn't contain the fork's Rust changes.
RUN yarn --cwd packages/cubejs-backend-native native:build-release

# Build CubeStore from source and wire it in where @cubejs-backend/cubestore looks for its binary
# (rust/cubestore/downloaded/latest/bin), so it is never downloaded at runtime.
RUN cd rust/cubestore \
    && cargo +nightly-2025-08-01 build --release -p cubestore \
    && mkdir -p downloaded/latest/bin \
    && cp target/release/cubestored downloaded/latest/bin/cubestored \
    && sha256sum downloaded/latest/bin/cubestored | awk '{print $1}' > /cubejs/transai-cubestored.sha256

# Keep only what runs: drop the Rust build output and sources, then reinstall production
# dependencies for the server workspaces. The reinstall re-runs the native post-install, which may
# replace index.node with a prebuilt binary, so the one built above is restored afterwards.
RUN rm -rf rust/cubestore/target packages/cubejs-backend-native/target rust/cube \
    && cp packages/cubejs-backend-native/index.node /tmp/index.node \
    && find . -name 'node_modules' -type d -prune -exec rm -rf '{}' + \
    && yarn workspaces focus --production \
        @cubejs-backend/server \
        @cubejs-backend/postgres-driver \
        @cubejs-backend/cubestore-driver \
        @cubejs-backend/cubestore \
        cubejs-cli \
    && cp /tmp/index.node packages/cubejs-backend-native/index.node \
    && yarn cache clean --all

FROM node:22.22.0-bookworm-slim AS final

ARG IMAGE_VERSION=dev

ENV CUBEJS_DOCKER_IMAGE_VERSION=$IMAGE_VERSION
ENV CUBEJS_DOCKER_IMAGE_TAG=latest

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    # python3 package is necessary to install `python3` executable for node-gyp
    && apt-get install -y --no-install-recommends libssl3 curl ca-certificates \
       cmake python3 python3.11 libpython3.11-dev gcc g++ make cmake openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

ENV TERM=rxvt-unicode
ENV NODE_ENV=production
ENV CUBESTORE_SKIP_POST_INSTALL=true

COPY --from=build /cubejs /cubejs

# /cube/conf is the mount point for the Cube project; /cube/node_modules exposes the server's
# packages to it (see NODE_PATH)
RUN mkdir -p /cube/conf \
    && ln -s /cubejs/node_modules /cube/node_modules \
    && ln -s /cubejs/packages/cubejs-docker/bin /cube/bin
COPY packages/cubejs-docker/bin /cubejs/packages/cubejs-docker/bin

# By default Node dont search in parent directory from /cube/conf, @todo Reaserch a little bit more
ENV NODE_PATH=/cube/conf/node_modules:/cube/node_modules
ENV PYTHONUNBUFFERED=1
RUN ln -s /cubejs/packages/cubejs-docker/bin/cubejs-dev /usr/local/bin/cubejs \
    && ln -s /cubejs/rust/cubestore/bin/cubestore-dev /usr/local/bin/cubestore-dev

WORKDIR /cube/conf

EXPOSE 4000

CMD ["sh", "-c", "CUSTOM_CUBESTORE_BIN=/cubejs/rust/cubestore/downloaded/latest/bin/cubestored; EXPECTED_SHA=$(cat /cubejs/transai-cubestored.sha256 2>/dev/null || true); ACTUAL_SHA=$(sha256sum \"$CUSTOM_CUBESTORE_BIN\" 2>/dev/null | awk '{print $1}' || true); if [ -n \"$ACTUAL_SHA\" ] && [ \"$EXPECTED_SHA\" = \"$ACTUAL_SHA\" ]; then echo \"[transAI/Cube] Docker runtime using custom Rust cubestored (sha256=$ACTUAL_SHA)\"; else echo \"[transAI/Cube][WARN] Docker runtime could not verify custom cubestored (expected=$EXPECTED_SHA actual=$ACTUAL_SHA path=$CUSTOM_CUBESTORE_BIN)\"; fi; exec cubejs server"]
