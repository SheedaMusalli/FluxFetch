# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/rohit267/net-merge/issues) and include:

- your OS and version, and `net-merge version`
- the output of `net-merge list` and `net-merge status`
- what you expected and what happened
- how your connections are set up (for example Wi-Fi + iPhone USB)

For a security problem, see [SECURITY.md](SECURITY.md) instead.

## Building and testing

You need Go (the version in `go.mod`). On macOS you also need the Xcode command line tools.

```
go build -o net-merge ./cmd/net-merge
go vet ./...
go test ./...
```

- On **macOS** the engine tests use `127.0.0.2` and `127.0.0.3` as stand-in adapters. Add them once with
  `sudo ifconfig lo0 alias 127.0.0.2/32` and `sudo ifconfig lo0 alias 127.0.0.3/32`. Without them those
  tests skip.
- Check the other platforms still compile: `GOOS=windows go vet ./...` and `GOOS=linux go vet ./...`.
- To run net-merge on Windows from source you need `wintun.dll` (see [docs/DEVELOPING.md](docs/DEVELOPING.md)).

How it works and where things live: [docs/DEVELOPING.md](docs/DEVELOPING.md).

## Pull requests

- Keep each pull request small and about one thing. Say what it changes and why, and how you tested it.
- OS-specific code goes in `_windows.go`, `_linux.go` or `_darwin.go` files next to the shared code.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- If you change Go dependencies, update `vendorHash` in `nix/package.nix` (`nix build` prints the new one).
- Keep the README in simple words.

CI runs the tests on Windows, Linux and macOS, a real end-to-end run on Linux, a smoke test on macOS and the
Nix build. Please make sure they pass.

By contributing you agree that your work is released under the [MIT license](LICENSE).
