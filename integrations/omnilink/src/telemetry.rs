use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

#[derive(Clone, Default, Debug)]
pub struct AdapterTelemetry {
    pub if_index: u32,
    pub routed_bps: u64,
    pub network_rx_bps: Option<u64>,
    pub connections: usize,
}

#[derive(Clone, Debug)]
pub struct TelemetrySnapshot {
    pub sampled_at: Instant,
    pub observed_bps: Option<u64>,
    pub routed_bps: u64,
    pub adapters: Vec<AdapterTelemetry>,
    pub observer_status: String,
    pub routing_status: &'static str,
}
impl Default for TelemetrySnapshot {
    fn default() -> Self {
        Self {
            sampled_at: Instant::now(),
            observed_bps: None,
            routed_bps: 0,
            adapters: Vec::new(),
            observer_status: "Starting network observer".into(),
            routing_status: "WAITING",
        }
    }
}
impl TelemetrySnapshot {
    pub fn stale(&self) -> bool {
        self.sampled_at.elapsed() > Duration::from_secs(3)
    }
    pub fn observed_text(&self) -> String {
        format_rate(if self.stale() {
            None
        } else {
            self.observed_bps
        })
    }
    pub fn routed_text(&self) -> String {
        format_rate(if self.stale() {
            None
        } else {
            Some(self.routed_bps)
        })
    }
}

pub fn format_rate(bps: Option<u64>) -> String {
    match bps {
        None => "Unavailable".into(),
        Some(bps) if bps >= 1_000_000_000 => format!("{:.2} Gbps", bps as f64 / 1e9),
        Some(bps) => format!("{:.1} Mbps", bps as f64 / 1e6),
    }
}

pub fn routing_status(enabled: bool, ready: bool, adapters: &[AdapterTelemetry]) -> &'static str {
    if !ready {
        "UNAVAILABLE"
    } else if !enabled {
        "PAUSED"
    } else {
        match adapters.iter().filter(|a| a.routed_bps > 0).count() {
            2.. => "MULTIPLE LINKS",
            1 => "ONE LINK",
            _ if adapters.iter().any(|a| a.connections > 0) => "CONNECTED / IDLE",
            _ => "WAITING",
        }
    }
}

pub struct Frame {
    pub elapsed: Duration,
    pub observed_bytes: Option<u64>,
    pub adapters: Vec<(u32, u64, Option<u64>, usize)>,
}
#[derive(Default)]
pub struct RateWindow {
    frames: VecDeque<Frame>,
}
impl RateWindow {
    pub fn push(
        &mut self,
        frame: Frame,
        now: Instant,
        observer_status: String,
        enabled: bool,
        ready: bool,
    ) -> TelemetrySnapshot {
        self.frames.push_back(frame);
        while self.frames.len() > 2 {
            self.frames.pop_front();
        }
        let seconds: f64 = self.frames.iter().map(|f| f.elapsed.as_secs_f64()).sum();
        let rate = |bytes: u64| {
            if seconds > 0.0 {
                (bytes as f64 * 8.0 / seconds) as u64
            } else {
                0
            }
        };
        let observed_bps = self
            .frames
            .iter()
            .map(|f| f.observed_bytes)
            .sum::<Option<u64>>()
            .map(rate);
        let mut accumulated = HashMap::<u32, (u64, Option<u64>)>::new();
        for frame in &self.frames {
            for (index, routed, nic, _) in &frame.adapters {
                let entry = accumulated.entry(*index).or_insert((0, Some(0)));
                entry.0 += routed;
                entry.1 = entry.1.zip(*nic).map(|(a, b)| a + b);
            }
        }
        let adapters: Vec<_> = self
            .frames
            .back()
            .unwrap()
            .adapters
            .iter()
            .map(|(index, _, _, connections)| {
                let (routed, nic) = accumulated[index];
                AdapterTelemetry {
                    if_index: *index,
                    routed_bps: rate(routed),
                    network_rx_bps: nic.map(rate),
                    connections: *connections,
                }
            })
            .collect();
        TelemetrySnapshot {
            sampled_at: now,
            observed_bps,
            routed_bps: adapters.iter().map(|a| a.routed_bps).sum(),
            routing_status: routing_status(enabled, ready, &adapters),
            adapters,
            observer_status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_actual_shared_elapsed_and_preserves_unavailable_observation() {
        let mut window = RateWindow::default();
        window.push(
            Frame {
                elapsed: Duration::from_millis(300),
                observed_bytes: Some(300_000),
                adapters: vec![
                    (1, 150_000, Some(400_000), 1),
                    (2, 150_000, Some(400_000), 1),
                ],
            },
            Instant::now(),
            "ok".into(),
            true,
            true,
        );
        let snapshot = window.push(
            Frame {
                elapsed: Duration::from_millis(700),
                observed_bytes: Some(700_000),
                adapters: vec![
                    (1, 350_000, Some(800_000), 1),
                    (2, 350_000, Some(800_000), 1),
                ],
            },
            Instant::now(),
            "ok".into(),
            true,
            true,
        );
        assert_eq!(snapshot.observed_bps, Some(8_000_000));
        assert_eq!(snapshot.routed_bps, 8_000_000);
        assert_eq!(
            snapshot.adapters.iter().map(|a| a.routed_bps).sum::<u64>(),
            snapshot.routed_bps
        );
        assert_eq!(snapshot.routing_status, "MULTIPLE LINKS");
        let failed = window.push(
            Frame {
                elapsed: Duration::from_millis(500),
                observed_bytes: None,
                adapters: vec![],
            },
            Instant::now(),
            "lost events".into(),
            true,
            true,
        );
        assert_eq!(failed.observed_bps, None);
        assert_eq!(failed.observed_text(), "Unavailable");
    }
    #[test]
    fn enabled_without_traffic_is_waiting_and_idle_expires() {
        assert_eq!(routing_status(true, true, &[]), "WAITING");
        let mut window = RateWindow::default();
        window.push(
            Frame {
                elapsed: Duration::from_millis(500),
                observed_bytes: Some(1_000_000),
                adapters: vec![(1, 1_000_000, Some(1_000_000), 1)],
            },
            Instant::now(),
            "ok".into(),
            true,
            true,
        );
        for _ in 0..2 {
            window.push(
                Frame {
                    elapsed: Duration::from_millis(500),
                    observed_bytes: Some(0),
                    adapters: vec![(1, 0, Some(0), 0)],
                },
                Instant::now(),
                "ok".into(),
                true,
                true,
            );
        }
        let idle = window.push(
            Frame {
                elapsed: Duration::from_millis(500),
                observed_bytes: Some(0),
                adapters: vec![(1, 0, Some(0), 0)],
            },
            Instant::now(),
            "ok".into(),
            true,
            true,
        );
        assert_eq!(idle.observed_bps, Some(0));
        assert_eq!(idle.routed_bps, 0);
        let stale = TelemetrySnapshot {
            sampled_at: Instant::now() - Duration::from_secs(4),
            observed_bps: Some(5_000_000),
            ..Default::default()
        };
        assert_eq!(stale.observed_text(), "Unavailable");
    }
}
