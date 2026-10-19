use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::adapters::NetworkAdapter;

/// Scheduling strategy selectable from the system tray right-click menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulingMode {
    DynamicWeighted,
    RoundRobin,
}

/// Live lock-free telemetry for a single network interface.
pub struct AdapterState {
    pub adapter: NetworkAdapter,
    pub enabled: AtomicBool,
    pub healthy: AtomicBool,
    pub active_connections: AtomicUsize,
    /// Bytes transferred during the current sampling window
    window_bytes: AtomicU64,
    /// launcher-to-client payload bytes during the current sampling window.
    launcher_download_window_bytes: AtomicU64,
    /// Client-to-launcher payload bytes during the current sampling window.
    launcher_upload_window_bytes: AtomicU64,
    /// Recent launcher download samples, used to smooth the UI rate over about one second.
    launcher_download_history: Mutex<VecDeque<(u64, u64)>>,
    /// EWMA-smoothed throughput in bits per second
    pub current_bps: AtomicU64,
    /// launcher download speed measured on OmniLink's intercepted launcher streams.
    pub download_bps: AtomicU64,
    /// launcher upload speed measured on OmniLink's intercepted launcher streams.
    pub upload_bps: AtomicU64,
    /// Highest observed throughput (bps), seeded with a 50 Mbps slow-start probe floor
    pub peak_bps: AtomicU64,
    /// EWMA-smoothed TCP connect RTT in microseconds
    pub ewma_rtt_us: AtomicU64,
    /// Consecutive socket connection or stall failures
    pub consecutive_failures: AtomicUsize,
}

const INITIAL_PROBE_BPS: u64 = 50_000_000; // 50 Mbps initial probe floor
const MIN_HEADROOM_BPS: u64 = 5_000_000; // 5 Mbps minimum scheduling floor

/// At 500 ms per telemetry tick, this tracks live launcher rates over about one second.
const LAUNCHER_SPEED_HISTORY_SAMPLES: usize = 2;

impl AdapterState {
    pub fn new(adapter: NetworkAdapter) -> Self {
        Self {
            adapter,
            enabled: AtomicBool::new(true),
            healthy: AtomicBool::new(true),
            active_connections: AtomicUsize::new(0),
            window_bytes: AtomicU64::new(0),
            launcher_download_window_bytes: AtomicU64::new(0),
            launcher_upload_window_bytes: AtomicU64::new(0),
            launcher_download_history: Mutex::new(VecDeque::with_capacity(
                LAUNCHER_SPEED_HISTORY_SAMPLES,
            )),
            current_bps: AtomicU64::new(0),
            download_bps: AtomicU64::new(0),
            upload_bps: AtomicU64::new(0),
            peak_bps: AtomicU64::new(INITIAL_PROBE_BPS),
            ewma_rtt_us: AtomicU64::new(35_000), // Default 35ms initial estimate
            consecutive_failures: AtomicUsize::new(0),
        }
    }

    #[inline]
    pub fn record_bytes(&self, bytes: usize) {
        self.window_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_download_bytes(&self, bytes: usize) {
        self.record_bytes(bytes);
        self.launcher_download_window_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    #[inline]
    pub fn record_upload_bytes(&self, bytes: usize) {
        self.record_bytes(bytes);
        self.launcher_upload_window_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_launcher_download_sample(&self, bytes: u64, elapsed_secs: f64) {
        let elapsed_ms = (elapsed_secs * 1000.0).round().max(1.0) as u64;
        let Ok(mut history) = self.launcher_download_history.lock() else {
            return;
        };
        history.push_back((bytes, elapsed_ms));
        if history.len() > LAUNCHER_SPEED_HISTORY_SAMPLES {
            history.pop_front();
        }
        self.download_bps
            .store(rolling_bps(&history), Ordering::Relaxed);
    }

    pub fn record_connect_success(&self, rtt: Duration) {
        self.consecutive_failures.store(0, Ordering::Relaxed);
        self.healthy.store(true, Ordering::Relaxed);

        let sample_us = (rtt.as_micros() as u64).max(500);
        let prev_us = self.ewma_rtt_us.load(Ordering::Relaxed);
        // EWMA: 75% historical, 25% new sample
        let next_us = (prev_us * 3 + sample_us) / 4;
        self.ewma_rtt_us.store(next_us, Ordering::Relaxed);
    }

    pub fn record_failure(&self) {
        let fails = self.consecutive_failures.fetch_add(1, Ordering::Relaxed) + 1;
        if fails >= 4 {
            // Temporarily mark unhealthy until the background health probe succeeds
            self.healthy.store(false, Ordering::Relaxed);
        }
    }

    #[inline]
    pub fn current_mbps(&self) -> f64 {
        self.download_mbps()
    }

    #[inline]
    pub fn download_mbps(&self) -> f64 {
        (self.download_bps.load(Ordering::Relaxed) as f64) / 1_000_000.0
    }

    #[inline]
    pub fn upload_mbps(&self) -> f64 {
        (self.upload_bps.load(Ordering::Relaxed) as f64) / 1_000_000.0
    }

    /// Computes the Dynamic Capacity-Weighted Score:
    /// Score = (AvailableHeadroom / (ActiveConns + 1)) * (1 / sqrt(RTT_ms))
    pub fn compute_weight_score(&self) -> f64 {
        if !self.enabled.load(Ordering::Relaxed) || !self.healthy.load(Ordering::Relaxed) {
            return -1.0;
        }

        let cur_bps = self.current_bps.load(Ordering::Relaxed);
        let peak_bps = self.peak_bps.load(Ordering::Relaxed).max(INITIAL_PROBE_BPS);
        let headroom_bps = peak_bps.saturating_sub(cur_bps).max(MIN_HEADROOM_BPS) as f64;

        let active = self.active_connections.load(Ordering::Relaxed) as f64;
        let rtt_ms = ((self.ewma_rtt_us.load(Ordering::Relaxed) as f64) / 1000.0).max(1.0);
        let fails = self.consecutive_failures.load(Ordering::Relaxed) as f64;

        // Penalize adapters with recent transient errors
        let penalty = 1.0 / (1.0 + fails * 2.0);

        (headroom_bps / (active + 1.0)) * (1.0 / rtt_ms.sqrt()) * penalty
    }
}

pub struct LoadBalancer {
    states: RwLock<Vec<Arc<AdapterState>>>,
    mode: RwLock<SchedulingMode>,
    rr_counter: AtomicUsize,
    bonding_enabled: AtomicBool,
    transferring: AtomicBool,
}

impl LoadBalancer {
    pub fn new(initial_adapters: Vec<NetworkAdapter>) -> Arc<Self> {
        let states = initial_adapters
            .into_iter()
            .map(|a| Arc::new(AdapterState::new(a)))
            .collect();

        let lb = Arc::new(Self {
            states: RwLock::new(states),
            mode: RwLock::new(SchedulingMode::DynamicWeighted),
            rr_counter: AtomicUsize::new(0),
            bonding_enabled: AtomicBool::new(true),
            transferring: AtomicBool::new(false),
        });

        Self::spawn_telemetry_ticker(Arc::clone(&lb));
        lb
    }

    pub fn is_bonding_enabled(&self) -> bool {
        self.bonding_enabled.load(Ordering::Relaxed)
    }

    pub fn set_bonding_enabled(&self, enabled: bool) {
        self.bonding_enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn scheduling_mode(&self) -> SchedulingMode {
        *self.mode.read().unwrap()
    }

    pub fn set_scheduling_mode(&self, mode: SchedulingMode) {
        *self.mode.write().unwrap() = mode;
    }

    pub fn set_adapter_enabled(&self, if_index: u32, enabled: bool) {
        if let Ok(guard) = self.states.read() {
            for state in guard.iter() {
                if state.adapter.if_index == if_index {
                    state.enabled.store(enabled, Ordering::SeqCst);
                    if enabled {
                        state.consecutive_failures.store(0, Ordering::Relaxed);
                        state.healthy.store(true, Ordering::Relaxed);
                    }
                    break;
                }
            }
        }
    }

    /// Reconciles newly discovered or unplugged adapters without resetting metrics for existing NICs.
    pub fn sync_adapters(&self, discovered: Vec<NetworkAdapter>) -> bool {
        let mut guard = self.states.write().unwrap();
        let mut updated = Vec::with_capacity(discovered.len());
        let mut changed = guard.len() != discovered.len();

        for nic in discovered {
            if let Some(existing) = guard.iter().find(|s| s.adapter.if_index == nic.if_index) {
                if existing.adapter == nic {
                    updated.push(Arc::clone(existing));
                } else {
                    // Keep the user's enable/disable choice, but replace stale address and route
                    // data so newly connected or changed networks use the current interface.
                    changed = true;
                    let refreshed = Arc::new(AdapterState::new(nic));
                    refreshed
                        .enabled
                        .store(existing.enabled.load(Ordering::Relaxed), Ordering::Relaxed);
                    updated.push(refreshed);
                }
            } else {
                changed = true;
                updated.push(Arc::new(AdapterState::new(nic)));
            }
        }

        if changed {
            *guard = updated;
        }
        changed
    }

    pub fn snapshot_states(&self) -> Vec<Arc<AdapterState>> {
        self.states.read().unwrap().clone()
    }

    pub fn total_mbps(&self) -> f64 {
        self.total_download_mbps()
    }

    pub fn total_download_mbps(&self) -> f64 {
        if !self.is_transferring() {
            return 0.0;
        }
        self.states
            .read()
            .unwrap()
            .iter()
            .map(|s| s.download_mbps())
            .sum()
    }

    /// True while routed receive payload exists in the recent measurement window.
    pub fn is_transferring(&self) -> bool {
        self.transferring.load(Ordering::Relaxed)
    }

    pub fn total_upload_mbps(&self) -> f64 {
        self.states
            .read()
            .unwrap()
            .iter()
            .map(|s| s.upload_mbps())
            .sum()
    }

    /// Selects the optimal network adapter for the next outbound launcher chunk socket.
    pub fn select_best_adapter(&self) -> Option<Arc<AdapterState>> {
        let guard = self.states.read().unwrap();
        if guard.is_empty() {
            return None;
        }

        // Collect all enabled + healthy adapters (or fall back to enabled if all marked unhealthy)
        let mut candidates: Vec<&Arc<AdapterState>> = guard
            .iter()
            .filter(|s| s.enabled.load(Ordering::Relaxed) && s.healthy.load(Ordering::Relaxed))
            .collect();

        if candidates.is_empty() {
            candidates = guard
                .iter()
                .filter(|s| s.enabled.load(Ordering::Relaxed))
                .collect();
        }

        if candidates.is_empty() {
            return None;
        }

        // If multi-NIC bonding is paused from the tray menu, pin to the primary adapter only
        if !self.is_bonding_enabled() {
            return Some(Arc::clone(candidates[0]));
        }

        match self.scheduling_mode() {
            SchedulingMode::RoundRobin => {
                let idx = self.rr_counter.fetch_add(1, Ordering::Relaxed) % candidates.len();
                Some(Arc::clone(candidates[idx]))
            }
            SchedulingMode::DynamicWeighted => candidates
                .into_iter()
                .max_by(|a, b| {
                    let score_a = a.compute_weight_score();
                    let score_b = b.compute_weight_score();
                    score_a
                        .partial_cmp(&score_b)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(Arc::clone),
        }
    }

    /// Background task that computes 500ms EWMA bandwidth and periodically probes unhealthy adapters.
    fn spawn_telemetry_ticker(lb: Arc<Self>) {
        std::thread::Builder::new()
            .name("omnilink-telemetry".into())
            .spawn(move || {
                let tick_interval = Duration::from_millis(500);
                let mut last_tick = Instant::now();
                let mut ticks: u64 = 0;
                loop {
                    std::thread::sleep(tick_interval);
                    let now = Instant::now();
                    let elapsed_secs = now.duration_since(last_tick).as_secs_f64().max(0.1);
                    last_tick = now;
                    ticks += 1;

                    let states = lb.snapshot_states();
                    for state in &states {
                        let bytes = state.window_bytes.swap(0, Ordering::Relaxed);
                        let instant_bps = ((bytes as f64 * 8.0) / elapsed_secs) as u64;

                        let prev_bps = state.current_bps.load(Ordering::Relaxed);
                        // Fast attack (60% new), smooth decay (40% new)
                        let smoothed_bps = if instant_bps > prev_bps {
                            (prev_bps * 2 + instant_bps * 3) / 5
                        } else {
                            (prev_bps * 3 + instant_bps * 2) / 5
                        };

                        state.current_bps.store(smoothed_bps, Ordering::Relaxed);

                        // Count routed client payload only; the one-second rolling window
                        // expires after two idle samples rather than retaining a stale rate.
                        let launcher_download_bytes = state
                            .launcher_download_window_bytes
                            .swap(0, Ordering::Relaxed);
                        let launcher_upload_bytes = state
                            .launcher_upload_window_bytes
                            .swap(0, Ordering::Relaxed);
                        state
                            .record_launcher_download_sample(launcher_download_bytes, elapsed_secs);
                        state.upload_bps.store(
                            ((launcher_upload_bytes as f64 * 8.0) / elapsed_secs) as u64,
                            Ordering::Relaxed,
                        );

                        // Update peak ceiling with slow decay (0.5% per tick) to adapt to ISP congestion
                        let prev_peak = state.peak_bps.load(Ordering::Relaxed);
                        let decayed_peak = ((prev_peak as f64) * 0.995) as u64;
                        let new_peak = smoothed_bps.max(decayed_peak).max(INITIAL_PROBE_BPS);
                        state.peak_bps.store(new_peak, Ordering::Relaxed);

                        // Auto-recover unhealthy adapters every 10 seconds (20 ticks) for re-probing
                        if ticks.is_multiple_of(20) && !state.healthy.load(Ordering::Relaxed) {
                            state.consecutive_failures.store(0, Ordering::Relaxed);
                            state.healthy.store(true, Ordering::Relaxed);
                        }
                    }

                    // Report routed payload activity for every configured client. Background
                    // requests are transfers too, so the UI does not call this a game download.
                    lb.transferring.store(
                        states
                            .iter()
                            .any(|state| state.download_bps.load(Ordering::Relaxed) > 0),
                        Ordering::Relaxed,
                    );
                }
            })
            .expect("Failed to spawn telemetry thread");
    }
}

fn rolling_bps(samples: &VecDeque<(u64, u64)>) -> u64 {
    let total_bytes: u64 = samples.iter().map(|(bytes, _)| bytes).sum();
    let total_ms: u64 = samples.iter().map(|(_, elapsed_ms)| elapsed_ms).sum();
    if total_ms == 0 {
        0
    } else {
        ((total_bytes as f64 * 8_000.0) / total_ms as f64) as u64
    }
}

#[cfg(test)]
mod download_activity_tests {
    use super::*;

    #[test]
    fn speed_uses_a_one_second_rolling_window_to_suppress_single_sample_spikes() {
        let steady = VecDeque::from([(100_000, 500); LAUNCHER_SPEED_HISTORY_SAMPLES]);
        let mut burst = VecDeque::from([(100_000, 500)]);
        burst.extend([(0, 500); LAUNCHER_SPEED_HISTORY_SAMPLES - 1]);

        assert_eq!(rolling_bps(&steady), 1_600_000);
        assert_eq!(rolling_bps(&burst), 800_000);
    }
}

#[cfg(test)]
mod adapter_sync_tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn adapter(if_index: u32, ipv4: Ipv4Addr) -> NetworkAdapter {
        NetworkAdapter {
            if_index,
            adapter_name: format!("{{adapter-{if_index}}}"),
            friendly_name: format!("Network {if_index}"),
            description: "Test adapter".to_string(),
            ipv4,
            gateway_ipv4: Ipv4Addr::new(192, 168, 1, 1),
            rx_link_speed_bps: 1_000_000_000,
            tx_link_speed_bps: 1_000_000_000,
            is_wireless: false,
        }
    }

    #[test]
    fn sync_adds_newly_connected_adapters_and_preserves_existing_state() {
        let load_balancer = LoadBalancer::new(vec![adapter(4, Ipv4Addr::new(192, 168, 1, 20))]);
        load_balancer.set_adapter_enabled(4, false);

        assert!(load_balancer.sync_adapters(vec![
            adapter(4, Ipv4Addr::new(192, 168, 1, 20)),
            adapter(9, Ipv4Addr::new(192, 168, 2, 20)),
        ]));

        let states = load_balancer.snapshot_states();
        assert_eq!(states.len(), 2);
        assert!(!states[0].enabled.load(Ordering::Relaxed));
        assert!(states[1].enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn sync_refreshes_addresses_for_an_existing_interface_index() {
        let load_balancer = LoadBalancer::new(vec![adapter(4, Ipv4Addr::new(192, 168, 1, 20))]);
        load_balancer.set_adapter_enabled(4, false);

        assert!(load_balancer.sync_adapters(vec![adapter(4, Ipv4Addr::new(192, 168, 1, 35),)]));

        let states = load_balancer.snapshot_states();
        assert_eq!(states[0].adapter.ipv4, Ipv4Addr::new(192, 168, 1, 35));
        assert!(!states[0].enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn unchanged_adapter_list_keeps_existing_state() {
        let load_balancer = LoadBalancer::new(vec![adapter(4, Ipv4Addr::new(192, 168, 1, 20))]);
        let original = load_balancer.snapshot_states()[0].clone();

        assert!(!load_balancer.sync_adapters(vec![adapter(4, Ipv4Addr::new(192, 168, 1, 20),)]));
        assert!(Arc::ptr_eq(&original, &load_balancer.snapshot_states()[0]));
    }
}
