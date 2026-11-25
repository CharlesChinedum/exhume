# linux/amd64 image for the séance risk checks. Foundry is pinned to exactly 1.5.1.
FROM --platform=linux/amd64 debian:bookworm-slim

ARG FOUNDRY_VERSION=1.5.1
ARG FORGE_STD_PIN=v1.9.4
ARG SOLC_LEGACY=0.4.19
ARG SOLC_MODERN=0.8.28

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git jq \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/root
ENV PATH=/root/.foundry/bin:$PATH

# Install exactly FOUNDRY_VERSION (never latest), then fail the build if forge disagrees.
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
 && foundryup --install "${FOUNDRY_VERSION}" \
 && forge --version | tee /tmp/forge-version \
 && grep -Eq "^forge Version: ${FOUNDRY_VERSION//./\\.}(-|\$)" /tmp/forge-version \
 && rm /tmp/forge-version

# Pinned forge-std, checked out at the commit the tag points to.
RUN git clone --quiet https://github.com/foundry-rs/forge-std /opt/forge-std \
 && git -C /opt/forge-std -c advice.detachedHead=false checkout --quiet "${FORGE_STD_PIN}"

# Warm forge's solc cache with the legacy and modern compilers by compiling a
# tiny project, and fail the build if either exact version is not used.
RUN mkdir /tmp/warm/ && cd /tmp/warm \
 && mkdir src \
 && printf 'pragma solidity =%s;\ncontract Old { uint256 public x; }\n' "${SOLC_LEGACY}" > src/Old.sol \
 && printf '// SPDX-License-Identifier: UNLICENSED\npragma solidity =%s;\ncontract New { uint256 public x; }\n' "${SOLC_MODERN}" > src/New.sol \
 && forge build \
 && grep -q "\"version\":\"${SOLC_LEGACY}+" out/Old.sol/Old.json \
 && grep -q "\"version\":\"${SOLC_MODERN}+" out/New.sol/New.json \
 && cd / && rm -rf /tmp/warm

WORKDIR /work
