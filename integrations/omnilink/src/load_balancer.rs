use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
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
    /// EWMA-smoothed throughput in bits per second
    pub current_bps: AtomicU64,
    /// Total hardware download speed in bits per second
    pub download_bps: AtomicU64,
    /// Total hardware upload speed in bits per second
    pub upload_bps: AtomicU64,
    /// Last recorded raw hardware RX octets
    last_hardware_rx: AtomicU64,
    /// Last recorded raw hardware TX octets
    last_hardware_tx: AtomicU64,
    /// Highest observed throughput (bps), seeded with a 50 Mbps slow-start probe floor
    pub peak_bps: AtomicU64,
    /// EWMA-smoothed TCP connect RTT in microseconds
    pub ewma_rtt_us: AtomicU64,
    /// Consecutive socket connection or stall failures
    pub consecutive_failures: AtomicUsize,
}

const INITIAL_PROBE_BPS: u64 = 50_000_000; // 50 Mbps initial probe floor
const MIN_HEADROOM_BPS: u64 = 5_000_000; // 5 Mbps minimum scheduling floor

impl AdapterState {
    pub fn new(adapter: NetworkAdapter) -> Self {
        Self {
            adapter,
            enabled: AtomicBool::new(true),
            healthy: AtomicBool::new(true),
            active_connections: AtomicUsize::new(0),
            window_bytes: AtomicU64::new(0),
            current_bps: AtomicU64::new(0),
            download_bps: AtomicU64::new(0),
            upload_bps: AtomicU64::new(0),
            last_hardware_rx: AtomicU64::new(0),
            last_hardware_tx: AtomicU64::new(0),
            peak_bps: AtomicU64::new(INITIAL_PROBE_BPS),
            ewma_rtt_us: AtomicU64::new(35_000), // Default 35ms initial estimate
            consecutive_failures: AtomicUsize::new(0),
        }
    }

    #[inline]
    pub fn record_bytes(&self, bytes: usize) {
        self.window_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
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
        let dl_bps = self.download_bps.load(Ordering::Relaxed);
        let proxy_bps = self.current_bps.load(Ordering::Relaxed);
        (dl_bps.max(proxy_bps) as f64) / 1_000_000.0
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
    pub fn sync_adapters(&self, discovered: Vec<NetworkAdapter>) {
        let mut guard = self.states.write().unwrap();
        let mut updated = Vec::with_capacity(discovered.len());

        for nic in discovered {
            if let Some(existing) = guard.iter().find(|s| s.adapter.if_index == nic.if_index) {
                updated.push(Arc::clone(existing));
            } else {
                updated.push(Arc::new(AdapterState::new(nic)));
            }
        }
        *guard = updated;
    }

    pub fn snapshot_states(&self) -> Vec<Arc<AdapterState>> {
        self.states.read().unwrap().clone()
    }

    pub fn total_mbps(&self) -> f64 {
        self.total_download_mbps()
    }

    pub fn total_download_mbps(&self) -> f64 {
        self.states
            .read()
            .unwrap()
            .iter()
            .map(|s| s.download_mbps())
            .sum()
    }

    pub fn total_upload_mbps(&self) -> f64 {
        self.states
            .read()
            .unwrap()
            .iter()
            .map(|s| s.upload_mbps())
            .sum()
    }

    /// Selects the optimal network adapter for the next outbound Steam chunk socket.
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

                        // Poll real-time hardware download (RX) and upload (TX) octets
                        if let Some((cur_rx, cur_tx)) =
                            crate::adapters::get_adapter_octets(state.adapter.if_index)
                        {
                            let prev_rx = state.last_hardware_rx.swap(cur_rx, Ordering::Relaxed);
                            let prev_tx = state.last_hardware_tx.swap(cur_tx, Ordering::Relaxed);

                            if prev_rx > 0 && cur_rx >= prev_rx {
                                let diff_rx = cur_rx - prev_rx;
                                let instant_rx_bps = ((diff_rx as f64 * 8.0) / elapsed_secs) as u64;
                                let old_rx = state.download_bps.load(Ordering::Relaxed);
                                let smooth_rx = if instant_rx_bps > old_rx {
                                    (old_rx * 2 + instant_rx_bps * 3) / 5
                                } else {
                                    (old_rx * 3 + instant_rx_bps * 2) / 5
                                };
                                state.download_bps.store(smooth_rx, Ordering::Relaxed);
                            }

                            if prev_tx > 0 && cur_tx >= prev_tx {
                                let diff_tx = cur_tx - prev_tx;
                                let instant_tx_bps = ((diff_tx as f64 * 8.0) / elapsed_secs) as u64;
                                let old_tx = state.upload_bps.load(Ordering::Relaxed);
                                let smooth_tx = if instant_tx_bps > old_tx {
                                    (old_tx * 2 + instant_tx_bps * 3) / 5
                                } else {
                                    (old_tx * 3 + instant_tx_bps * 2) / 5
                                };
                                state.upload_bps.store(smooth_tx, Ordering::Relaxed);
                            }
                        }

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
                }
            })
            .expect("Failed to spawn telemetry thread");
    }
}
