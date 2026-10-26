#!/usr/bin/env bash
# Adds the signed Alpine (apk) and Arch (pacman) repositories to the site build-repos.sh made.
# They need Alpine's and Arch's own tools, so each is built in its container (docker).
#
#   GPG_KEY_ID=<fingerprint> APK_KEY=/path/net-merge.rsa \
#       scripts/build-container-repos.sh PKG_DIR SITE_DIR
#
# The key in the gpg keyring signs the Arch packages and database; APK_KEY (an RSA private key
# whose public half sits next to it as net-merge.rsa.pub) signs the Alpine index.
set -euo pipefail
PKGS=$(realpath "${1:?usage: build-container-repos.sh PKG_DIR SITE_DIR}")
SITE=$(realpath "${2:?usage: build-container-repos.sh PKG_DIR SITE_DIR}")
KEY=${GPG_KEY_ID:?set GPG_KEY_ID to the signing key fingerprint}
APK_KEY=$(realpath "${APK_KEY:?set APK_KEY to the Alpine RSA private key}")
[ "$(basename "$APK_KEY")" = net-merge.rsa ] || { echo "APK_KEY must be named net-merge.rsa (apk matches the key by file name)"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gpg --batch --pinentry-mode loopback --export-secret-keys --armor "$KEY" > "$tmp/gpg.key"
owner="$(id -u):$(id -g)"

# ---- Alpine: <arch>/APKINDEX.tar.gz next to the packages, index signed with the RSA key
docker run --rm -e OWNER="$owner" \
    -v "$PKGS:/pkgs:ro" -v "$SITE:/site" -v "$APK_KEY:/key/net-merge.rsa:ro" -v "$APK_KEY.pub:/key/net-merge.rsa.pub:ro" \
    alpine:3.22 sh -ec '
        apk add --no-cache abuild >/dev/null
        for f in /pkgs/*.apk; do
            b=$(basename "$f" .apk); arch=${b#net-merge_*_}   # net-merge_1.2.3_x86_64 -> x86_64
            ver=$(tar -xzOf "$f" .PKGINFO | sed -n "s/^pkgver = //p")
            mkdir -p /site/apk/$arch
            cp "$f" /site/apk/$arch/net-merge-$ver.apk   # apk looks for <name>-<version>.apk
        done
        for d in /site/apk/*/; do
            (cd "$d" && apk index --allow-untrusted -o APKINDEX.tar.gz *.apk && abuild-sign -k /key/net-merge.rsa APKINDEX.tar.gz)
        done
        cp /key/net-merge.rsa.pub /site/apk/net-merge.rsa.pub
        chown -R "$OWNER" /site/apk'

# ---- Arch: <arch>/net-merge.db next to the packages, packages and database signed with the gpg key
docker run --rm -e OWNER="$owner" -e KEY="$KEY" \
    -v "$PKGS:/pkgs:ro" -v "$SITE:/site" -v "$tmp/gpg.key:/gpg.key:ro" \
    archlinux:latest bash -ec '
        gpg --batch --import /gpg.key
        sign() { gpg --batch --yes --pinentry-mode loopback --local-user "$KEY" --detach-sign --output "$1.sig" "$1"; }
        for f in /pkgs/*.pkg.tar.zst; do
            arch=${f%.pkg.tar.zst}; arch=${arch##*-}
            mkdir -p /site/arch/$arch
            cp "$f" /site/arch/$arch/
            sign "/site/arch/$arch/$(basename "$f")"
        done
        for d in /site/arch/*/; do
            (cd "$d" && repo-add --quiet --sign --key "$KEY" net-merge.db.tar.zst *.pkg.tar.zst)
            # GitHub Pages cannot serve symlinks: pacman asks for net-merge.db, so make real copies
            for l in "$d"*; do
                [ -L "$l" ] && cp --remove-destination "$(readlink -f "$l")" "$l"
            done
        done
        chown -R "$OWNER" /site/arch'
echo "added the Alpine and Arch repositories to $SITE"
