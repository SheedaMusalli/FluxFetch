#!/bin/sh
# Lets net-merge create its virtual adapter without running as root. File capabilities are
# dropped whenever the binary is replaced, so this runs on every install and upgrade.
if command -v setcap >/dev/null 2>&1; then
    setcap cap_net_admin,cap_net_raw+ep /usr/bin/net-merge || echo "net-merge: setcap failed; run: sudo setcap cap_net_admin,cap_net_raw+ep /usr/bin/net-merge"
else
    echo "net-merge: setcap not found; install libcap and run: sudo setcap cap_net_admin,cap_net_raw+ep /usr/bin/net-merge"
fi

# The repositories moved from rohit267.github.io/net-merge to pkg.net-merge.org: point an existing setup
# at the new address, so it keeps updating once the old one is gone.
for f in /etc/apt/sources.list.d/net-merge.list /etc/yum.repos.d/net-merge.repo /etc/zypp/repos.d/net-merge.repo \
    /etc/apk/repositories /etc/pacman.conf; do
    if [ -f "$f" ] && grep -q 'rohit267.github.io/net-merge' "$f"; then
        sed -i 's#https://rohit267.github.io/net-merge#https://pkg.net-merge.org#g' "$f"
    fi
done
exit 0
