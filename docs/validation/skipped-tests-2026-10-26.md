# Previously skipped smoke cases — 26 October 2026

All nine cases skipped in the preceding smoke run subsequently passed across targeted runs. Production source and installer bytes were unchanged during this follow-up; changes are confined to test setup, the Windows permission test, comments and these reports.

## Network conditions

Actual source-binding probes found that this Windows host rejected connections from its LAN addresses to the loopback origin with `EADDRNOTAVAIL`. It accepted `127.0.0.2` and `127.0.0.3`, and the HTTP server observed exactly those remote addresses. The network tests ran with source A `127.0.0.1` and source B `127.0.0.2`.

Global setup now tries all available LAN candidates and falls back to a validated distinct loopback address. It checks the address actually observed by the server and logs the fixture type. The `FLUXFETCH_E2E_LAN` name remains for compatibility. These cases exercise real TCP binding, server-observed byte attribution and download-engine reactions to simulated interface changes. They do not enable/disable physical NICs or demonstrate independent Internet connections, bandwidth aggregation or hardware WAN failover.

## Passed cases

| Case                                                                           | Result |
| ------------------------------------------------------------------------------ | ------ |
| Two sources share work; attributed bytes equal server-observed bytes           | Passed |
| One source fails permanently; the other finishes the file                      | Passed |
| A source disappears and returns; it carries data again                         | Passed |
| Newly available source stays off until enabled; off/on controls remain correct | Passed |
| Rapidly switching the last source off/on leaves the intended final state       | Passed |
| Resume with all sources disabled selects a source still available              | Passed |
| Unreachable source retains a retry stream and recovers its stream count        | Passed |
| Changed source address reconnects before the long retry backoff expires        | Passed |
| Nonwritable Windows destination refuses start without orphaned files           | Passed |

## Windows permission case

The POSIX-only `chmod` implementation was replaced on Windows with an explicit deny of `WD,AD` (file/directory creation) for the current user's SID on the test fixture's newly created destination directory. No user download directory or repository ACL was changed. A direct write is asserted to fail before the app is asked to start. The app must then refuse the download, with no destination reservation, partial file, or download manifest directory left behind.

Cleanup removes only the deny introduced by this fixture and compares the ACL listing with its original value. A successful write after restoration is also checked.

The first run passed all eight network cases, but permission-test cleanup failed because `icacls /restore` required a privilege the test account did not have. The temporary deny was removed manually. A second attempt showed that denying all writes also blocked the directory-listing check. The test now denies only file and directory creation, leaving reads available. The final run passed, restored the original ACL, and cleaned up its fixture.

## Evidence and checks

- First run (eight network passes and a cleanup error): `artifacts/previously-skipped-tests` (**8 passed, 1 failed**).
- Second permission-test diagnostic: `artifacts/windows-permission-retest`.
- Final Windows permission case: `artifacts/windows-permission-final/.last-run.json` (**1 passed**, no skips).
- E2E TypeScript checking and ESLint on the modified test files passed.
- At the time of these test reruns, installer bytes remained unchanged: `artifacts/net-merge-release/fluxfetch-2.0.1-net-merge-tested-setup.exe`, SHA-256 `412D9758ADE71B3C2EED6C2FB3FCEE4CED3089F43788276F9A90CD8797A56A6F`. A subsequent user-requested rebuild is recorded in [the current build report](net-merge-and-concurrent-downloads-2026-10-26.md).
