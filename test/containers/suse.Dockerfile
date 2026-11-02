# The suse family's test image (openSUSE Leap and Tumbleweed), for just linux-test (tools/linux-test.js, parity 0.9).
# BASE is a row's image from matrix.json (tag@sha256). Network is used here, at build time only.
ARG BASE=scratch
FROM ${BASE}
ARG MISE_VERSION
ARG MISE_ARCH
ARG MISE_SHA256
LABEL org.workstation-steward.test=1
# Node 26's Linux binaries need libatomic, which minimal images leave out (found by the first run, 2026-11-02)
RUN zypper -n --gpg-auto-import-keys refresh \
 && zypper -n install --no-recommends \
      bash git-core python3 util-linux procps ca-certificates curl tar gzip xz findutils shadow libatomic1 diffutils jq \
 && zypper -n clean -a
COPY install-mise.sh /tmp/install-mise.sh
RUN sh /tmp/install-mise.sh && rm /tmp/install-mise.sh
# the example toolchain, as the Tests workflow installs it (tools/linux-test.js copies examples/mise/config.toml here)
ENV MISE_DATA_DIR=/opt/mise MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml MISE_YES=1
COPY .mise-config.toml /opt/mise/config.toml
RUN mise install && chmod -R a+rX /opt/mise
RUN useradd -m steward
ENV PATH=/opt/mise/shims:$PATH MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state MISE_OFFLINE=1 HOME=/work/home
USER steward
