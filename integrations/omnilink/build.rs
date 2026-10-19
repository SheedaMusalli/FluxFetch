use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=vendor/windivert/x64/WinDivert.lib");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor_dir = manifest_dir.join("vendor").join("windivert").join("x64");

    // 1. Instruct rustc where to find WinDivert.lib
    println!("cargo:rustc-link-search=native={}", vendor_dir.display());
    println!("cargo:rustc-link-lib=dylib=WinDivert");

    // 2. Copy WinDivert.dll and WinDivert64.sys next to the compiled executable and test runners
    if let Ok(out_dir) = env::var("OUT_DIR") {
        if let Some(target_profile_dir) = Path::new(&out_dir).ancestors().nth(3) {
            let deps_dir = target_profile_dir.join("deps");
            let examples_dir = target_profile_dir.join("examples");
            let _ = fs::create_dir_all(&deps_dir);
            let _ = fs::create_dir_all(&examples_dir);

            for filename in &["WinDivert.dll", "WinDivert64.sys"] {
                let src = vendor_dir.join(filename);
                if src.exists() {
                    let dst_profile = target_profile_dir.join(filename);
                    let _ = fs::copy(&src, &dst_profile);
                    let dst_deps = deps_dir.join(filename);
                    let _ = fs::copy(&src, &dst_deps);
                    let _ = fs::copy(&src, examples_dir.join(filename));
                } else {
                    println!(
                        "cargo:warning=Missing {} in {}. Place WinDivert 2.2 x64 files there before running.",
                        filename,
                        vendor_dir.display()
                    );
                }
            }
        }
    }

    // 3. Embed UAC Administrator Manifest and Windows PE Version Metadata
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let profile = env::var("PROFILE").unwrap_or_default();
        let force_admin = env::var("OMNILINK_ADMIN_MANIFEST").as_deref() == Ok("1");

        let mut res = winres::WindowsResource::new();
        if profile == "release" || force_admin {
            res.set_manifest_file("app.manifest");
        } else {
            res.set_manifest_file("app_dev.manifest");
        }

        res.set("ProductName", "OmniLink Multi-NIC Accelerator");
        res.set(
            "FileDescription",
            "OmniLink Background Multi-Adapter Load Balancer",
        );
        res.set("LegalCopyright", "Copyright (c) 2026");

        if Path::new("assets/icon.ico").exists() {
            res.set_icon("assets/icon.ico");
        }

        if let Err(e) = res.compile() {
            println!("cargo:warning=Failed to compile Windows resources: {}", e);
        }
    }
}
