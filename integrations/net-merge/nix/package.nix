{
  lib,
  buildGoModule,
  go_1_27,
  version ? "dev",
}:

(buildGoModule.override { go = go_1_27; }) {
  pname = "net-merge";
  inherit version;

  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ../go.mod
      ../go.sum
      ../cmd
      ../internal
    ];
  };

  vendorHash = "sha256-jbafKGjgOXZAcyQVILbZ3ZUUMhD8gpz+NGBT48Du7mA=";
  subPackages = [ "cmd/net-merge" ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
    "-X main.version=${version}"
  ];

  # The tests bind to loopback aliases and connect to local listeners; the sandbox allows that.
  doCheck = true;

  meta = {
    description = "Use all your network adapters at once: balances connections across Wi-Fi, Ethernet and tethers";
    homepage = "https://github.com/rohit267/net-merge";
    license = lib.licenses.mit;
    mainProgram = "net-merge";
    platforms = lib.platforms.linux ++ lib.platforms.windows;
  };
}
