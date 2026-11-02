#!/bin/sh
# install-mise.sh — mise from its GitHub release, checked against the sha256 in test/containers/matrix.json before it
# runs (parity 0.9). Build-time only: the test run itself has no network.
set -eu
url="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}.tar.gz"
curl -fsSL --retry 3 "$url" -o /tmp/mise.tgz
echo "${MISE_SHA256}  /tmp/mise.tgz" | sha256sum -c -
tar -xzf /tmp/mise.tgz -C /tmp
install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise
rm -rf /tmp/mise /tmp/mise.tgz
mise --version
