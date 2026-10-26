#!/usr/bin/env bash
# Smoke test of system-wide mode on macOS (CI runs it on macos-latest). Needs sudo and internet
# access. The runner has one NIC, so this checks the TUN, routes, relaying, off and crash safety,
# not balancing (that needs a second uplink: plug in a tether and watch `net-merge status`).
#
# usage: scripts/macos-smoke.sh ./net-merge
set -uo pipefail
BIN=$(cd "$(dirname "${1:-./net-merge}")" && pwd)/$(basename "${1:-./net-merge}")
STATE=/tmp/net-merge-smoke
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }

cleanup() { sudo pkill -f "$BIN run" 2>/dev/null; sudo "$BIN" cleanup >/dev/null 2>&1; }
trap cleanup EXIT

wait_on() { # wait until `net-merge status` reports ON
    for _ in $(seq 1 40); do
        "$BIN" status -state-dir "$STATE" 2>/dev/null | grep -q 'is ON' && return 0
        sleep 0.5
    done
    return 1
}
http() { curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com; }
captured() { netstat -rn -f inet | grep -cE '^(0/1|128.0/1) '; }
scoped_defaults() { netstat -rn -f inet | grep -E '^default' | grep -cE 'UG[A-Za-z]*I'; }

rm -rf "$STATE"
echo "== adapters"
"$BIN" list | grep -E '^(USE|skip  en)'

echo "== system-wide ON"
sudo "$BIN" run -state-dir "$STATE" -log "$STATE.log" -stats 0 -for 150s &
wait_on && pass "net-merge turned on" || { fail "net-merge did not turn on"; cat "$STATE.log"; exit 1; }
sleep 4 # let the internet probes finish
"$BIN" status -state-dir "$STATE"

[ "$(captured)" = 2 ] && pass "capture routes 0/1 + 128.0/1 present" || fail "capture routes: $(captured), want 2"
tun=$(ifconfig -l | tr ' ' '\n' | grep '^utun' | while read -r i; do ifconfig "$i" | grep -qE 'inet 198\.1[89]\.[0-9]+\.1 ' && echo "$i"; done)
[ -n "$tun" ] && pass "utun $tun has an address in 198.18.0.0/15" || fail "no utun with an address in 198.18.0.0/15"
mtu=$(ifconfig "$tun" 2>/dev/null | sed -n 's/.*mtu \([0-9]*\).*/\1/p')
[ "$mtu" = 9000 ] && pass "TUN MTU is 9000" || fail "TUN MTU is $mtu, want 9000"
[ "$(http)" = 200 ] && pass "HTTPS works through net-merge" || fail "HTTPS through net-merge failed"
dig +short +time=3 +tries=1 @1.1.1.1 example.com | grep -qE '^[0-9.]+$' &&
    pass "UDP DNS to 1.1.1.1 works through net-merge" || fail "UDP DNS through net-merge failed"
relayed=$(jq '[.NICs[].Total] | add' /var/run/net-merge/status.json 2>/dev/null || jq '[.NICs[].Total] | add' "$STATE/status.json")
[ "${relayed:-0}" -ge 1 ] && pass "flows were relayed by net-merge ($relayed)" || fail "no flow went through net-merge"

# What macOS does when a tether becomes the primary service: the old primary loses its unscoped
# default and gets a scoped one, which ours already is. It must survive the next sync (#20).
echo "== the primary adapter stops being primary: its scoped default must stay"
read -r gw nic < <(netstat -rn -f inet | awk '$1 == "default" && $3 !~ /I/ {print $2, $4; exit}')
sudo route -q -n delete default "$gw"
sleep 5 # more than one 3 s sync
netstat -rn -f inet | grep -E "^default .*I.* $nic" >/dev/null &&
    pass "$nic keeps a scoped default after it stops being primary" || fail "$nic lost its default route when it stopped being primary"
[ "$(http)" = 200 ] && pass "HTTPS still works through net-merge" || fail "HTTPS through net-merge failed after the handover"
# and back: macOS replaces the scoped default with an unscoped one, net-merge adds its own again
sudo route -q -n delete default "$gw" -ifscope "$nic"
sudo route -q -n add default "$gw"
sleep 5
netstat -rn -f inet | grep -E "^default .*I.* $nic" >/dev/null &&
    pass "net-merge scoped $nic again once it was primary again" || fail "no scoped default on $nic after it became primary again"

echo "== off: adapter, routes and scoped defaults go away, internet still works"
"$BIN" off -state-dir "$STATE"
sleep 1
[ "$(captured)" = 0 ] && pass "capture routes removed" || fail "capture routes still present"
[ "$(scoped_defaults)" = 0 ] && pass "scoped default routes removed" || fail "scoped default routes left behind"
ifconfig "$tun" >/dev/null 2>&1 && fail "$tun still exists after off" || pass "utun removed after off"
[ "$(http)" = 200 ] && pass "internet works after off" || fail "internet after off failed"

echo "== crash: kill -9 must not leave the machine without internet"
sudo "$BIN" run -state-dir "$STATE" -log "$STATE-2.log" -stats 0 -for 120s &
wait_on || fail "second start did not turn on"
pid=$(jq -r .PID "$STATE/status.json" 2>/dev/null)
sudo kill -9 "$pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do   # the kernel drops the utun once the killed process is gone
    [ "$(captured)" = 0 ] && break; sleep 1
done
[ "$(captured)" = 0 ] && pass "capture routes gone after kill -9" || fail "capture routes survived kill -9"
[ "$(http)" = 200 ] && pass "internet works after kill -9" || fail "internet after kill -9 failed"
sudo "$BIN" cleanup >/dev/null
[ "$(scoped_defaults)" = 0 ] && pass "cleanup removed the leftover scoped defaults" || fail "scoped defaults left after cleanup"

# The runner's /usr/local/bin is writable by its user, like an Intel Mac with Homebrew, so this takes
# the /opt/net-merge/bin path.
echo "== install: a root-owned copy and the passwordless rule, then uninstall"
if sudo "$BIN" install; then
    exe=$(readlink -f /usr/local/bin/net-merge)
    sudo -n -l "$exe" tray >/dev/null && pass "passwordless rule for $exe tray" || fail "no passwordless rule for $exe tray"
    [ "$(stat -f %u "$exe")" = 0 ] && pass "the installed copy is owned by root" || fail "the installed copy is not owned by root"
    sudo "$BIN" uninstall >/dev/null
    [ ! -e /etc/sudoers.d/net-merge ] && [ ! -e /opt/net-merge ] && [ ! -L /usr/local/bin/net-merge ] &&
        pass "uninstall removed the rule and the copy" || fail "uninstall left files behind"
else
    fail "sudo net-merge install failed"
fi

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit "$fails"
