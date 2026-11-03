# The debian family's test image (Debian, Ubuntu, Linux Mint and LMDE, from Mint's own images), for just linux-test (tools/linux-test.js, parity 0.9).
# BASE is a row's image from matrix.json (tag@sha256). Network is used here, at build time only.
ARG BASE=scratch
FROM ${BASE}
ARG MISE_VERSION
ARG MISE_ARCH
ARG MISE_SHA256
# a row's extra pins (matrix.json `extra`): Mint 22.3's image ships Ubuntu's base-files, ranked above Mint's own, so its
# os-release says Ubuntu; the row puts Mint's back, as a fresh install has it (owner, 2026-11-03), hence --allow-downgrades
ARG EXTRA=
LABEL org.workstation-steward.test=1
# Node 26's Linux binaries need libatomic, which minimal images leave out (found by the first run, 2026-11-02)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash git python3 util-linux procps ca-certificates curl tar gzip xz-utils findutils passwd libatomic1 \
 && if [ -n "$EXTRA" ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --allow-downgrades $EXTRA; fi \
 && rm -rf /var/lib/apt/lists/*
COPY install-mise.sh /tmp/install-mise.sh
RUN sh /tmp/install-mise.sh && rm /tmp/install-mise.sh
# the example toolchain, as the Tests workflow installs it (tools/linux-test.js copies examples/mise/config.toml here)
ENV MISE_DATA_DIR=/opt/mise MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml MISE_YES=1
COPY .mise-config.toml /opt/mise/config.toml
RUN mise install && chmod -R a+rX /opt/mise
RUN useradd -m steward
ENV PATH=/opt/mise/shims:$PATH MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state MISE_OFFLINE=1 HOME=/work/home
USER steward
