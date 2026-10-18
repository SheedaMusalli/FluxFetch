use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use muda::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::WindowId;

use crate::adapters::discover_routable_adapters;
use crate::interceptor::SteamInterceptor;
use crate::load_balancer::{LoadBalancer, SchedulingMode};

const ID_HEADER: &str = "header_status";
const ID_TOGGLE_BONDING: &str = "toggle_bonding";
const ID_TOGGLE_OVERLAY: &str = "toggle_overlay";
const ID_MODE_WEIGHTED: &str = "mode_weighted";
const ID_MODE_RR: &str = "mode_rr";
const ID_REFRESH_NICS: &str = "refresh_nics";
const ID_AUTOSTART: &str = "toggle_autostart";
const ID_QUIT: &str = "quit_app";
const ADAPTER_ID_PREFIX: &str = "nic_";

pub struct OmniLinkTrayApp {
    load_balancer: Arc<LoadBalancer>,
    interceptor: Arc<SteamInterceptor>,
    overlay: Arc<crate::overlay::OverlayController>,
    tray_icon: Option<TrayIcon>,
    header_item: MenuItem,
    toggle_bonding_item: CheckMenuItem,
    toggle_overlay_item: CheckMenuItem,
    mode_weighted_item: CheckMenuItem,
    mode_rr_item: CheckMenuItem,
    adapters_submenu: Submenu,
    adapter_menu_items: HashMap<u32, CheckMenuItem>,
    last_ui_refresh: Instant,
}

impl OmniLinkTrayApp {
    pub fn new(
        load_balancer: Arc<LoadBalancer>,
        interceptor: Arc<SteamInterceptor>,
        overlay: Arc<crate::overlay::OverlayController>,
    ) -> Self {
        let header_item = MenuItem::with_id(ID_HEADER, "OmniLink: Active (0.0 Mbps)", false, None);
        let toggle_bonding_item = CheckMenuItem::with_id(
            ID_TOGGLE_BONDING,
            "Enable Multi-NIC Bonding (steam.exe)",
            true,
            true,
            None,
        );
        let toggle_overlay_item = CheckMenuItem::with_id(
            ID_TOGGLE_OVERLAY,
            "Show Desktop HUD Overlay",
            true,
            overlay.is_visible(),
            None,
        );
        let mode_weighted_item = CheckMenuItem::with_id(
            ID_MODE_WEIGHTED,
            "Dynamic Capacity Weighted (Recommended)",
            true,
            true,
            None,
        );
        let mode_rr_item =
            CheckMenuItem::with_id(ID_MODE_RR, "Strict Round-Robin", true, false, None);
        let adapters_submenu = Submenu::new("Network Adapters", true);

        Self {
            load_balancer,
            interceptor,
            overlay,
            tray_icon: None,
            header_item,
            toggle_bonding_item,
            toggle_overlay_item,
            mode_weighted_item,
            mode_rr_item,
            adapters_submenu,
            adapter_menu_items: HashMap::new(),
            last_ui_refresh: Instant::now(),
        }
    }

    /// Runs the headless Windows message pump for the system tray icon.
    pub fn run(mut self) {
        let event_loop = EventLoop::new().expect("Failed to create Windows event loop");
        event_loop
            .run_app(&mut self)
            .expect("Event loop terminated");
    }

    fn build_tray(&mut self) {
        let menu = Menu::new();

        let _ = menu.append(&self.header_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&self.toggle_bonding_item);
        let _ = menu.append(&self.toggle_overlay_item);
        let _ = menu.append(&PredefinedMenuItem::separator());

        // Populate discovered network adapters submenu
        self.rebuild_adapter_submenu();
        let _ = menu.append(&self.adapters_submenu);

        // Scheduling mode submenu
        let sched_submenu = Submenu::new("Scheduling Mode", true);
        let _ = sched_submenu.append(&self.mode_weighted_item);
        let _ = sched_submenu.append(&self.mode_rr_item);
        let _ = menu.append(&sched_submenu);

        let refresh_item =
            MenuItem::with_id(ID_REFRESH_NICS, "Rescan Network Adapters", true, None);
        let autostart_item = CheckMenuItem::with_id(
            ID_AUTOSTART,
            "Start with Windows",
            true,
            is_autostart_enabled(),
            None,
        );
        let quit_item = MenuItem::with_id(ID_QUIT, "Quit OmniLink", true, None);

        let _ = menu.append(&refresh_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&autostart_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&quit_item);

        let icon = generate_status_icon(true);
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("OmniLink — Multi-NIC Download Accelerator")
            .with_icon(icon)
            .build()
            .expect("Failed to create system tray icon");

        self.tray_icon = Some(tray);
    }

    fn rebuild_adapter_submenu(&mut self) {
        // Remove previous items from submenu
        for (_, item) in self.adapter_menu_items.drain() {
            let _ = self.adapters_submenu.remove(&item);
        }

        for state in self.load_balancer.snapshot_states() {
            let if_index = state.adapter.if_index;
            let menu_id = format!("{}{}", ADAPTER_ID_PREFIX, if_index);
            let label = state.adapter.tray_label(state.current_mbps());
            let enabled = state.enabled.load(std::sync::atomic::Ordering::Relaxed);

            let item = CheckMenuItem::with_id(menu_id, label, true, enabled, None);
            let _ = self.adapters_submenu.append(&item);
            self.adapter_menu_items.insert(if_index, item);
        }
    }

    fn refresh_live_telemetry(&mut self) {
        let total_mbps = self.load_balancer.total_mbps();
        let interceptor_ready = self.interceptor.is_running();
        let active = self.load_balancer.is_bonding_enabled() && interceptor_ready;

        let status_text = if !interceptor_ready {
            format!(
                "OmniLink: Interception unavailable ({:.1} Mbps)",
                total_mbps
            )
        } else if active {
            format!("OmniLink: Active ({:.1} Mbps)", total_mbps)
        } else {
            format!("OmniLink: Paused ({:.1} Mbps)", total_mbps)
        };
        self.header_item.set_text(&status_text);
        self.toggle_bonding_item.set_checked(active);

        // Keep overlay toggle checkmark synchronized with live overlay visibility
        self.toggle_overlay_item
            .set_checked(self.overlay.is_visible());

        if let Some(tray) = &self.tray_icon {
            let _ = tray.set_tooltip(Some(status_text));
        }

        for state in self.load_balancer.snapshot_states() {
            if let Some(item) = self.adapter_menu_items.get(&state.adapter.if_index) {
                let updated_label = state.adapter.tray_label(state.current_mbps());
                item.set_text(updated_label);
            }
        }
    }

    fn handle_menu_click(&mut self, id: &MenuId, event_loop: &ActiveEventLoop) {
        let raw_id = id.as_ref();

        match raw_id {
            ID_TOGGLE_BONDING => {
                let enabled = self.toggle_bonding_item.is_checked();
                self.load_balancer.set_bonding_enabled(enabled);
                if let Some(tray) = &self.tray_icon {
                    let _ = tray.set_icon(Some(generate_status_icon(enabled)));
                }
                self.refresh_live_telemetry();
            }
            ID_TOGGLE_OVERLAY => {
                let visible = self.toggle_overlay_item.is_checked();
                self.overlay.set_visible(visible);
            }
            ID_MODE_WEIGHTED => {
                self.mode_weighted_item.set_checked(true);
                self.mode_rr_item.set_checked(false);
                self.load_balancer
                    .set_scheduling_mode(SchedulingMode::DynamicWeighted);
            }
            ID_MODE_RR => {
                self.mode_rr_item.set_checked(true);
                self.mode_weighted_item.set_checked(false);
                self.load_balancer
                    .set_scheduling_mode(SchedulingMode::RoundRobin);
            }
            ID_REFRESH_NICS => {
                if let Ok(discovered) = discover_routable_adapters() {
                    self.load_balancer.sync_adapters(discovered);
                    self.rebuild_adapter_submenu();
                }
            }
            ID_AUTOSTART => {
                let target_state = !is_autostart_enabled();
                set_autostart_enabled(target_state);
            }
            ID_QUIT => {
                self.overlay.set_visible(false);
                self.interceptor.stop();
                self.tray_icon.take();
                event_loop.exit();
            }
            other if other.starts_with(ADAPTER_ID_PREFIX) => {
                if let Ok(if_index) = other[ADAPTER_ID_PREFIX.len()..].parse::<u32>() {
                    if let Some(item) = self.adapter_menu_items.get(&if_index) {
                        self.load_balancer
                            .set_adapter_enabled(if_index, item.is_checked());
                    }
                }
            }
            _ => {}
        }
    }
}

impl ApplicationHandler for OmniLinkTrayApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.tray_icon.is_none() {
            self.build_tray();
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_secs(1),
        ));
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        _event: WindowEvent,
    ) {
        // Headless tray app has no windows
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            self.handle_menu_click(event.id(), event_loop);
        }

        if self.last_ui_refresh.elapsed() >= Duration::from_secs(1) {
            self.refresh_live_telemetry();
            self.last_ui_refresh = Instant::now();
        }

        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_secs(1),
        ));
    }
}

fn dist_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let pax = px - ax;
    let pay = py - ay;
    let bax = bx - ax;
    let bay = by - ay;
    let len_sq = bax * bax + bay * bay;
    let h = if len_sq > 0.0 {
        ((pax * bax + pay * bay) / len_sq).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let dx = pax - bax * h;
    let dy = pay - bay * h;
    (dx * dx + dy * dy).sqrt()
}

fn dist_circle(px: f32, py: f32, cx: f32, cy: f32, r: f32) -> f32 {
    let dx = px - cx;
    let dy = py - cy;
    (dx * dx + dy * dy).sqrt() - r
}

/// Programmatically renders a crisp 32x32 RGBA system tray icon for OmniLink with 4x MSAA anti-aliasing.
fn generate_status_icon(active: bool) -> Icon {
    let size = 32usize;
    let mut rgba = vec![0u8; size * size * 4];

    let samples: [(f32, f32); 4] = [(-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)];

    for py in 0..size {
        for px in 0..size {
            let mut accum_r = 0.0f32;
            let mut accum_g = 0.0f32;
            let mut accum_b = 0.0f32;
            let mut accum_a = 0.0f32;

            for (sx, sy) in samples {
                let nx = ((px as f32 + 0.5 + sx) / size as f32) * 2.0 - 1.0;
                let ny = ((py as f32 + 0.5 + sy) / size as f32) * 2.0 - 1.0;

                // 1. Squircle Badge Container
                let squircle_dist = (nx.abs().powf(4.2) + ny.abs().powf(4.2)).powf(1.0 / 4.2);
                let badge_radius = 0.88f32;
                let badge_edge = 0.04f32;

                if squircle_dist > badge_radius + badge_edge {
                    continue;
                }

                let badge_alpha =
                    ((badge_radius + badge_edge - squircle_dist) / badge_edge).clamp(0.0, 1.0);

                // Base Background
                let (mut bg_r, mut bg_g, mut bg_b) = if active {
                    // Deep Slate 900 gradient with subtle indigo depth
                    let t = ((nx + ny + 1.4) / 2.8).clamp(0.0, 1.0);
                    (
                        15.0 * (1.0 - t) + 24.0 * t,
                        23.0 * (1.0 - t) + 30.0 * t,
                        42.0 * (1.0 - t) + 64.0 * t,
                    )
                } else {
                    // Muted Dark Slate
                    (30.0, 41.0, 59.0)
                };

                // Outer Rim Accent Border
                let rim_dist = (squircle_dist - badge_radius).abs();
                let rim_w = 0.04f32;
                if rim_dist < rim_w {
                    let rim_intensity = (1.0 - rim_dist / rim_w).powf(1.5);
                    let (rim_r, rim_g, rim_b) = if active {
                        // Cyan to Emerald gradient rim
                        let t = ((nx + 1.0) * 0.5).clamp(0.0, 1.0);
                        (
                            56.0 * (1.0 - t) + 52.0 * t,
                            189.0 * (1.0 - t) + 211.0 * t,
                            248.0 * (1.0 - t) + 153.0 * t,
                        )
                    } else {
                        (71.0, 85.0, 105.0)
                    };
                    bg_r = bg_r * (1.0 - rim_intensity) + rim_r * rim_intensity;
                    bg_g = bg_g * (1.0 - rim_intensity) + rim_g * rim_intensity;
                    bg_b = bg_b * (1.0 - rim_intensity) + rim_b * rim_intensity;
                }

                let mut cur_r = bg_r;
                let mut cur_g = bg_g;
                let mut cur_b = bg_b;
                let cur_a = badge_alpha;

                // 2. Foreground OmniLink Multi-NIC Bonding Symbol
                let line_w = 0.08f32;
                let node_r = 0.12f32;

                // Streams converging into center link
                let d_stream1 = dist_segment(nx, ny, -0.46, -0.38, 0.05, 0.0);
                let d_stream2 = dist_segment(nx, ny, -0.56, 0.00, 0.05, 0.0);
                let d_stream3 = dist_segment(nx, ny, -0.46, 0.38, 0.05, 0.0);
                let d_turbo = dist_segment(nx, ny, 0.05, 0.0, 0.48, 0.0);

                let d_node_top = dist_circle(nx, ny, -0.46, -0.38, node_r);
                let d_node_mid = dist_circle(nx, ny, -0.56, 0.00, node_r);
                let d_node_bot = dist_circle(nx, ny, -0.46, 0.38, node_r);
                let d_node_apex = dist_circle(nx, ny, 0.48, 0.00, node_r * 1.15);

                if active {
                    // Stream 1 (Top LAN link - Sky Blue)
                    if d_stream1 < line_w {
                        let intense = ((line_w - d_stream1) / 0.02).clamp(0.0, 1.0);
                        cur_r = cur_r * (1.0 - intense) + 56.0 * intense;
                        cur_g = cur_g * (1.0 - intense) + 189.0 * intense;
                        cur_b = cur_b * (1.0 - intense) + 248.0 * intense;
                    }

                    // Stream 3 (Bot Cellular link - Emerald Mint)
                    if d_stream3 < line_w {
                        let intense = ((line_w - d_stream3) / 0.02).clamp(0.0, 1.0);
                        cur_r = cur_r * (1.0 - intense) + 52.0 * intense;
                        cur_g = cur_g * (1.0 - intense) + 211.0 * intense;
                        cur_b = cur_b * (1.0 - intense) + 153.0 * intense;
                    }

                    // Stream 2 (Mid Wi-Fi link - Electric Indigo)
                    if d_stream2 < line_w {
                        let intense = ((line_w - d_stream2) / 0.02).clamp(0.0, 1.0);
                        cur_r = cur_r * (1.0 - intense) + 129.0 * intense;
                        cur_g = cur_g * (1.0 - intense) + 140.0 * intense;
                        cur_b = cur_b * (1.0 - intense) + 248.0 * intense;
                    }

                    // Turbo Forward Beam (Vibrant Cyan-White)
                    if d_turbo < line_w * 1.3 {
                        let intense = ((line_w * 1.3 - d_turbo) / 0.02).clamp(0.0, 1.0);
                        cur_r = cur_r * (1.0 - intense) + 224.0 * intense;
                        cur_g = cur_g * (1.0 - intense) + 242.0 * intense;
                        cur_b = cur_b * (1.0 - intense) + 254.0 * intense;
                    }

                    // Glowing Nodes
                    if d_node_top < 0.0 {
                        let intense = (-d_node_top / 0.02).clamp(0.0, 1.0);
                        let core = ((-d_node_top - 0.04) / 0.02).clamp(0.0, 1.0);
                        let nr = 56.0 * (1.0 - core) + 240.0 * core;
                        let ng = 189.0 * (1.0 - core) + 250.0 * core;
                        let nb = 248.0 * (1.0 - core) + 255.0 * core;
                        cur_r = cur_r * (1.0 - intense) + nr * intense;
                        cur_g = cur_g * (1.0 - intense) + ng * intense;
                        cur_b = cur_b * (1.0 - intense) + nb * intense;
                    }

                    if d_node_mid < 0.0 {
                        let intense = (-d_node_mid / 0.02).clamp(0.0, 1.0);
                        let core = ((-d_node_mid - 0.04) / 0.02).clamp(0.0, 1.0);
                        let nr = 129.0 * (1.0 - core) + 240.0 * core;
                        let ng = 140.0 * (1.0 - core) + 250.0 * core;
                        let nb = 248.0 * (1.0 - core) + 255.0 * core;
                        cur_r = cur_r * (1.0 - intense) + nr * intense;
                        cur_g = cur_g * (1.0 - intense) + ng * intense;
                        cur_b = cur_b * (1.0 - intense) + nb * intense;
                    }

                    if d_node_bot < 0.0 {
                        let intense = (-d_node_bot / 0.02).clamp(0.0, 1.0);
                        let core = ((-d_node_bot - 0.04) / 0.02).clamp(0.0, 1.0);
                        let nr = 52.0 * (1.0 - core) + 240.0 * core;
                        let ng = 211.0 * (1.0 - core) + 255.0 * core;
                        let nb = 153.0 * (1.0 - core) + 240.0 * core;
                        cur_r = cur_r * (1.0 - intense) + nr * intense;
                        cur_g = cur_g * (1.0 - intense) + ng * intense;
                        cur_b = cur_b * (1.0 - intense) + nb * intense;
                    }

                    if d_node_apex < 0.0 {
                        let intense = (-d_node_apex / 0.02).clamp(0.0, 1.0);
                        let core = ((-d_node_apex - 0.03) / 0.02).clamp(0.0, 1.0);
                        let nr = 56.0 * (1.0 - core) + 255.0 * core;
                        let ng = 220.0 * (1.0 - core) + 255.0 * core;
                        let nb = 248.0 * (1.0 - core) + 255.0 * core;
                        cur_r = cur_r * (1.0 - intense) + nr * intense;
                        cur_g = cur_g * (1.0 - intense) + ng * intense;
                        cur_b = cur_b * (1.0 - intense) + nb * intense;
                    }
                } else {
                    // Muted Slate rendering for Paused state
                    let slate_r = 148.0f32;
                    let slate_g = 163.0f32;
                    let slate_b = 184.0f32;

                    for d in [d_stream1, d_stream2, d_stream3, d_turbo] {
                        if d < line_w {
                            let intense = ((line_w - d) / 0.02).clamp(0.0, 1.0);
                            cur_r = cur_r * (1.0 - intense) + slate_r * intense;
                            cur_g = cur_g * (1.0 - intense) + slate_g * intense;
                            cur_b = cur_b * (1.0 - intense) + slate_b * intense;
                        }
                    }

                    for d in [d_node_top, d_node_mid, d_node_bot, d_node_apex] {
                        if d < 0.0 {
                            let intense = (-d / 0.02).clamp(0.0, 1.0);
                            cur_r = cur_r * (1.0 - intense) + 226.0 * intense;
                            cur_g = cur_g * (1.0 - intense) + 232.0 * intense;
                            cur_b = cur_b * (1.0 - intense) + 240.0 * intense;
                        }
                    }
                }

                accum_r += cur_r;
                accum_g += cur_g;
                accum_b += cur_b;
                accum_a += cur_a;
            }

            let idx = (py * size + px) * 4;
            let final_a = accum_a / 4.0;
            if final_a > 0.001 {
                rgba[idx] = (accum_r / 4.0).clamp(0.0, 255.0) as u8;
                rgba[idx + 1] = (accum_g / 4.0).clamp(0.0, 255.0) as u8;
                rgba[idx + 2] = (accum_b / 4.0).clamp(0.0, 255.0) as u8;
                rgba[idx + 3] = (final_a * 255.0).clamp(0.0, 255.0) as u8;
            }
        }
    }

    Icon::from_rgba(rgba, size as u32, size as u32).expect("Failed to construct tray icon")
}

/// Checks `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OmniLink`
fn is_autostart_enabled() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ,
    };

    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
        .encode_utf16()
        .collect();
    let val_name: Vec<u16> = "OmniLink\0".encode_utf16().collect();
    let mut hkey = std::ptr::null_mut();

    unsafe {
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return false;
        }
        let exists = RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0;
        RegCloseKey(hkey);
        exists
    }
}

/// Sets or removes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OmniLink`
fn set_autostart_enabled(enable: bool) {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_WRITE,
        REG_SZ,
    };

    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
        .encode_utf16()
        .collect();
    let val_name: Vec<u16> = "OmniLink\0".encode_utf16().collect();
    let mut hkey = std::ptr::null_mut();

    unsafe {
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey) != 0 {
            return;
        }

        if enable {
            if let Ok(exe_path) = std::env::current_exe() {
                let quoted = format!("\"{}\"\0", exe_path.display());
                let wide: Vec<u16> = quoted.encode_utf16().collect();
                let byte_len = (wide.len() * 2) as u32;
                let _ = RegSetValueExW(
                    hkey,
                    val_name.as_ptr(),
                    0,
                    REG_SZ,
                    wide.as_ptr() as *const u8,
                    byte_len,
                );
            }
        } else {
            let _ = RegDeleteValueW(hkey, val_name.as_ptr());
        }

        RegCloseKey(hkey);
    }
}
