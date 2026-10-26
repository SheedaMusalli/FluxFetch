#!/usr/bin/env bash
# Builds the Linux tarball and the .deb, .rpm, .apk and Arch packages of one version for every
# architecture, from the repository root:   scripts/build-linux.sh VERSION OUT_DIR
# Pure Go, so one machine builds them all. Needs nfpm (NFPM=/path/to/nfpm if it is not on PATH).
set -euo pipefail
v=${1:?usage: build-linux.sh VERSION OUT_DIR}
mkdir -p "${2:?usage: build-linux.sh VERSION OUT_DIR}"
out=$(realpath "$2")
nfpm=${NFPM:-nfpm}
FORMATS=${FORMATS:-deb rpm apk archlinux}

# GOARCH  GOARM  nfpm-ARCH  tarball-name  [format to skip]
while read -r goarch goarm narch name skip; do
    CGO_ENABLED=0 GOOS=linux GOARCH=$goarch GOARM=${goarm/-/} \
        go build -trimpath -ldflags "-s -w -X main.version=$v" -o net-merge ./cmd/net-merge
    tar -czf "$out/net-merge-$v-linux-$name.tar.gz" net-merge LICENSE THIRD-PARTY-NOTICES.md
    for p in $FORMATS; do
        [ "$p" = "${skip:-}" ] && continue
        VERSION=$v ARCH=$narch "$nfpm" package -p "$p" -f packaging/nfpm.yaml -t "$out/"
    done
    rm net-merge
# Debian's armhf is the armv6 build, which also runs on armv7, so armv7 gets no .deb of its own.
done <<'ARCHS'
amd64   -  amd64   x86_64
arm64   -  arm64   aarch64
arm     7  arm7    armv7   deb
arm     6  arm6    armv6
386     -  386     i686
riscv64 -  riscv64 riscv64
ppc64le -  ppc64le ppc64le
s390x   -  s390x   s390x
loong64 -  loong64 loongarch64
ARCHS
