//! Independent process-attributed receive observation. Never logs packet contents.
use ferrisetw::trace::{TraceProperties, TraceTrait, UserTrace};
use ferrisetw::{parser::Parser, provider::Provider, schema_locator::SchemaLocator, EventRecord};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
use windows_sys::Win32::System::Diagnostics::Etw::{
    QueryTraceW, CONTROLTRACE_HANDLE, EVENT_TRACE_PROPERTIES,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

struct TargetInstance {
    handle: Option<usize>,
    created: i64,
    ended: Option<i64>,
    retired: Option<Instant>,
}
impl Drop for TargetInstance {
    fn drop(&mut self) {
        if let Some(handle) = self.handle {
            unsafe {
                CloseHandle(handle as _);
            }
        }
    }
}
fn filetime(value: FILETIME) -> i64 {
    ((value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64) as i64
}
impl TargetInstance {
    fn open(pid: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut instance = Self {
            handle: Some(handle as usize),
            created: 0,
            ended: None,
            retired: None,
        };
        instance.refresh()?;
        Some(instance)
    }
    fn refresh(&mut self) -> Option<()> {
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        if unsafe {
            GetProcessTimes(
                self.handle? as _,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return None;
        }
        self.created = filetime(created);
        if filetime(exited) != 0 {
            self.ended = Some(filetime(exited));
            self.retired.get_or_insert_with(Instant::now);
        }
        Some(())
    }
    fn contains(&self, timestamp: i64) -> bool {
        timestamp >= self.created && self.ended.is_none_or(|end| timestamp <= end)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct FlowKey {
    pub protocol: u8,
    pub local: SocketAddr,
    pub remote: SocketAddr,
}

#[derive(Default)]
struct Counters {
    targets: RwLock<HashMap<u32, Vec<TargetInstance>>>,
    // Entries remain briefly after close because ETW delivers events in buffers.
    clients: Mutex<HashMap<FlowKey, Option<Instant>>>,
    upstreams: Mutex<HashMap<FlowKey, Option<Instant>>>,
    bytes: AtomicU64,
    decode_errors: AtomicU64,
    target_errors: AtomicU64,
    running: AtomicBool,
}

impl Counters {
    fn is_target(&self, pid: u32, timestamp: i64) -> bool {
        self.targets
            .read()
            .unwrap()
            .get(&pid)
            .is_some_and(|instances| {
                instances
                    .iter()
                    .any(|instance| instance.contains(timestamp))
            })
    }
    fn update_targets(&self, targets: HashSet<u32>) {
        let now = Instant::now();
        let wall_time = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            / 100
            + 116444736000000000) as i64;
        let mut registry = self.targets.write().unwrap();
        for pid in &targets {
            if let Some(instance) = TargetInstance::open(*pid) {
                let entries = registry.entry(*pid).or_default();
                if let Some(existing) = entries
                    .iter_mut()
                    .find(|entry| entry.created == instance.created)
                {
                    if instance.ended.is_none() {
                        existing.ended = None;
                        existing.retired = None;
                    }
                } else {
                    entries.push(instance);
                }
            } else {
                self.target_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
        registry.retain(|pid, instances| {
            instances.retain_mut(|instance| {
                if instance.refresh().is_none() {
                    self.target_errors.fetch_add(1, Ordering::Relaxed);
                }
                if !targets.contains(pid) && instance.ended.is_none() {
                    instance.ended = Some(wall_time);
                    instance.retired = Some(now);
                }
                instance
                    .retired
                    .is_none_or(|retired| now.duration_since(retired) < Duration::from_secs(5))
            });
            !instances.is_empty()
        });
    }
    fn record(&self, pid: u32, flow: FlowKey, bytes: u32, allow_loopback: bool, timestamp: i64) {
        if !allow_loopback && (flow.local.ip().is_loopback() || flow.remote.ip().is_loopback()) {
            return;
        }
        let include = if pid == std::process::id() {
            self.upstreams.lock().unwrap().contains_key(&flow)
        } else {
            self.is_target(pid, timestamp) && !self.clients.lock().unwrap().contains_key(&flow)
        };
        if include {
            self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
        }
    }
}

pub struct ProxyObservation {
    counters: Arc<Counters>,
    client: Option<FlowKey>,
    upstream: FlowKey,
}
impl Drop for ProxyObservation {
    fn drop(&mut self) {
        let expires = Some(Instant::now() + Duration::from_secs(5));
        self.counters
            .upstreams
            .lock()
            .unwrap()
            .insert(self.upstream, expires);
        if let Some(client) = self.client {
            self.counters
                .clients
                .lock()
                .unwrap()
                .insert(client, expires);
        }
    }
}

pub struct ObservedSample {
    pub bytes: u64,
    pub status: String,
    pub healthy: bool,
}

pub struct TrafficObserver {
    counters: Arc<Counters>,
    trace: Mutex<Option<UserTrace>>,
    name: String,
    start_error: Option<String>,
    last_loss: Mutex<u64>,
}

impl TrafficObserver {
    pub fn new() -> Self {
        let targets = crate::launcher_profiles::target_names();
        let names: Vec<&str> = targets.iter().map(String::as_str).collect();
        Self::with_options(crate::interceptor::find_process_pids(&names), false)
    }

    /// Public for controlled diagnostics; production excludes localhost traffic.
    pub fn with_options(targets: HashSet<u32>, allow_loopback: bool) -> Self {
        let counters = Arc::new(Counters::default());
        counters.update_targets(targets);
        let callback_counters = Arc::clone(&counters);
        let callback = move |record: &EventRecord, locator: &SchemaLocator| {
            // Microsoft-Windows-Kernel-Network receive events: TCP v4/v6, UDP v4/v6.
            if !matches!(record.event_id(), 11 | 27 | 43 | 59) {
                return;
            }
            let parsed = (|| {
                let schema = locator.event_schema(record).ok()?;
                let parser = Parser::create(record, &schema);
                let pid: u32 = parser.try_parse("PID").ok()?;
                // Network event PID, NEVER the event-header thread's PID.
                if pid != std::process::id()
                    && !callback_counters.is_target(pid, record.raw_timestamp())
                {
                    return Some(());
                }
                let bytes: u32 = parser.try_parse("size").ok()?;
                let local: IpAddr = parser.try_parse("daddr").ok()?;
                let remote: IpAddr = parser.try_parse("saddr").ok()?;
                let local_port: u16 = parser.try_parse("dport").ok()?;
                let remote_port: u16 = parser.try_parse("sport").ok()?;
                let flow = FlowKey {
                    protocol: if matches!(record.event_id(), 11 | 27) {
                        6
                    } else {
                        17
                    },
                    local: SocketAddr::new(local, u16::from_be(local_port)),
                    remote: SocketAddr::new(remote, u16::from_be(remote_port)),
                };
                callback_counters.record(pid, flow, bytes, allow_loopback, record.raw_timestamp());
                Some(())
            })();
            if parsed.is_none() {
                callback_counters
                    .decode_errors
                    .fetch_add(1, Ordering::Relaxed);
            }
        };
        let name = format!("FluxFetch-OmniLink-Network-{}", std::process::id());
        let provider = Provider::by_guid("7dd42a49-5329-4832-8dfd-43d979153a88")
            .add_callback(callback)
            .build();
        let props = TraceProperties {
            buffer_size: 64,
            min_buffer: 16,
            max_buffer: 128,
            ..Default::default()
        };
        let started = UserTrace::new()
            .named(name.clone())
            .set_trace_properties(props)
            .enable(provider)
            .start();
        let (trace, start_error) = match started {
            Ok((trace, handle)) => {
                counters.running.store(true, Ordering::Relaxed);
                let running = Arc::clone(&counters);
                std::thread::spawn(move || {
                    let _ = UserTrace::process_from_handle(handle);
                    running.running.store(false, Ordering::Relaxed);
                });
                (Some(trace), None)
            }
            Err(error) => (
                None,
                Some(format!("Network observer unavailable: {error:?}")),
            ),
        };
        Self {
            counters,
            trace: Mutex::new(trace),
            name,
            start_error,
            last_loss: Mutex::new(0),
        }
    }

    pub fn set_targets(&self, targets: HashSet<u32>) {
        self.counters.update_targets(targets);
    }

    pub fn register_proxy(&self, client: Option<FlowKey>, upstream: FlowKey) -> ProxyObservation {
        self.counters
            .upstreams
            .lock()
            .unwrap()
            .insert(upstream, None);
        if let Some(client) = client {
            self.counters.clients.lock().unwrap().insert(client, None);
        }
        ProxyObservation {
            counters: Arc::clone(&self.counters),
            client,
            upstream,
        }
    }

    pub fn sample(&self) -> ObservedSample {
        let now = Instant::now();
        self.counters
            .clients
            .lock()
            .unwrap()
            .retain(|_, expiry| expiry.is_none_or(|t| t > now));
        self.counters
            .upstreams
            .lock()
            .unwrap()
            .retain(|_, expiry| expiry.is_none_or(|t| t > now));
        let bytes = self.counters.bytes.swap(0, Ordering::Relaxed);
        let decode_errors = self.counters.decode_errors.swap(0, Ordering::Relaxed);
        let target_errors = self.counters.target_errors.swap(0, Ordering::Relaxed);
        if let Some(error) = &self.start_error {
            return ObservedSample {
                bytes,
                status: error.clone(),
                healthy: false,
            };
        }
        if !self.counters.running.load(Ordering::Relaxed) {
            return ObservedSample {
                bytes,
                status: "Network observer stopped".into(),
                healthy: false,
            };
        }
        match query_lost(&self.name) {
            Ok(loss) => {
                let mut previous = self.last_loss.lock().unwrap();
                let missed = loss.saturating_sub(*previous);
                *previous = loss;
                let healthy = missed == 0 && decode_errors == 0 && target_errors == 0;
                ObservedSample {
                    bytes,
                    healthy,
                    status: if healthy {
                        "TCP + UDP / IPv4 + IPv6".into()
                    } else {
                        format!(
                            "Incomplete observation: {missed} lost, {decode_errors} decode errors, {target_errors} process queries failed"
                        )
                    },
                }
            }
            Err(code) => ObservedSample {
                bytes,
                healthy: false,
                status: format!("Observer health unavailable ({code})"),
            },
        }
    }

    pub fn stop(&self) {
        self.trace.lock().unwrap().take();
        self.counters.running.store(false, Ordering::Relaxed);
    }
}
impl Default for TrafficObserver {
    fn default() -> Self {
        Self::new()
    }
}

fn query_lost(name: &str) -> Result<u64, u32> {
    #[repr(C)]
    struct Query {
        properties: EVENT_TRACE_PROPERTIES,
        name: [u16; 256],
    }
    let mut query: Query = unsafe { std::mem::zeroed() };
    query.properties.Wnode.BufferSize = std::mem::size_of::<Query>() as u32;
    query.properties.LoggerNameOffset = std::mem::offset_of!(Query, name) as u32;
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        QueryTraceW(
            CONTROLTRACE_HANDLE { Value: 0 },
            name.as_ptr(),
            &mut query.properties,
        )
    };
    if result != 0 {
        return Err(result);
    }
    Ok(query.properties.EventsLost as u64
        + query.properties.LogBuffersLost as u64
        + query.properties.RealTimeBuffersLost as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn instance(created: i64, ended: Option<i64>) -> TargetInstance {
        TargetInstance {
            handle: None,
            created,
            ended,
            retired: None,
        }
    }
    fn flow(port: u16) -> FlowKey {
        FlowKey {
            protocol: 6,
            local: format!("192.0.2.1:{port}").parse().unwrap(),
            remote: "198.51.100.1:443".parse().unwrap(),
        }
    }
    #[test]
    fn observes_direct_existing_flows_without_a_relay_and_ignores_other_apps() {
        let counters = Counters::default();
        counters
            .targets
            .write()
            .unwrap()
            .insert(42, vec![instance(0, None)]);
        counters.record(42, flow(6000), 1000, false, 1);
        counters.record(43, flow(6001), 9000, false, 1);
        assert_eq!(counters.bytes.load(Ordering::Relaxed), 1000);
    }
    #[test]
    fn counts_proxy_upstream_once_and_excludes_reinjected_delivery() {
        let counters = Counters::default();
        counters
            .targets
            .write()
            .unwrap()
            .insert(42, vec![instance(0, None)]);
        counters.clients.lock().unwrap().insert(flow(6000), None);
        counters.upstreams.lock().unwrap().insert(flow(6001), None);
        counters.record(std::process::id(), flow(6001), 1000, false, 1);
        counters.record(42, flow(6000), 1000, false, 1);
        counters.record(std::process::id(), flow(6002), 3000, false, 1);
        assert_eq!(counters.bytes.load(Ordering::Relaxed), 1000);
    }
    #[test]
    fn buffered_events_are_matched_to_process_lifetime_not_reused_pid() {
        let counters = Counters::default();
        counters
            .targets
            .write()
            .unwrap()
            .insert(42, vec![instance(10, Some(20)), instance(30, None)]);
        assert!(counters.is_target(42, 15));
        assert!(!counters.is_target(42, 25));
        assert!(counters.is_target(42, 35));
    }
    #[test]
    fn udp_on_same_endpoints_is_not_confused_with_a_proxied_tcp_flow() {
        let counters = Counters::default();
        counters
            .targets
            .write()
            .unwrap()
            .insert(42, vec![instance(0, None)]);
        counters.clients.lock().unwrap().insert(flow(6000), None);
        let mut udp = flow(6000);
        udp.protocol = 17;
        counters.record(42, udp, 1000, false, 1);
        assert_eq!(counters.bytes.load(Ordering::Relaxed), 1000);
    }
}
