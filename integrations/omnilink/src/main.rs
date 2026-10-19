#![windows_subsystem = "windows"]

use std::sync::Arc;
use windows_sys::Win32::Networking::WinSock::{WSAStartup, WSADATA};

use omnilink_tray::adapters::discover_routable_adapters;
use omnilink_tray::dispatcher::BondDispatcher;
use omnilink_tray::interceptor::LauncherInterceptor;
use omnilink_tray::load_balancer::LoadBalancer;
use omnilink_tray::overlay::OverlayController;
use omnilink_tray::tray::OmniLinkTrayApp;

const DISPATCHER_PORT: u16 = 19080;

fn init_winsock() {
    unsafe {
        let mut wsa_data: WSADATA = std::mem::zeroed();
        let _ = WSAStartup(0x0202, &mut wsa_data);
    }
}

fn main() {
    init_winsock();

    // 1. Discover all active IPv4 WAN adapters (Ethernet, Wi-Fi, USB 5G Tether, etc.)
    let initial_adapters = discover_routable_adapters().unwrap_or_default();

    // 2. Initialize the EWMA Dynamic Load Balancer
    let load_balancer = LoadBalancer::new(initial_adapters);

    // 3. Start the WinDivert transparent packet interceptor for target applications
    let interceptor = Arc::new(LauncherInterceptor::new(DISPATCHER_PORT));
    // Do not advertise bonding as active if Windows rejects the driver handle.
    if interceptor.start().is_err() {
        load_balancer.set_bonding_enabled(false);
    }

    // 4. Initialize the always-on-top, draggable OmniLink overlay.
    let overlay = OverlayController::new(Arc::clone(&load_balancer), Arc::clone(&interceptor));

    // 5. Spawn the multi-threaded Tokio runtime for high-throughput socket splicing
    let lb_for_proxy = Arc::clone(&load_balancer);
    let interceptor_for_proxy = Arc::clone(&interceptor);

    std::thread::Builder::new()
        .name("omnilink-tokio-runtime".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("Failed to build Tokio runtime");

            rt.block_on(async move {
                let dispatcher =
                    BondDispatcher::new(DISPATCHER_PORT, lb_for_proxy, interceptor_for_proxy);
                let _ = dispatcher.run().await;
            });
        })
        .expect("Failed to spawn Tokio runtime thread");

    // 6. Run the headless System Tray UI on the main Windows thread
    let tray_app = OmniLinkTrayApp::new(load_balancer, interceptor, overlay);
    tray_app.run();
}
