use std::collections::HashSet;
use std::ffi::CString;
use std::io;
use std::mem::size_of;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    TCP_TABLE_OWNER_PID_CONNECTIONS,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

// Raw FFI bindings to WinDivert.dll (WinDivert 2.2+ Microsoft-signed WFP driver)
#[link(name = "WinDivert")]
extern "system" {
    fn WinDivertOpen(filter: *const i8, layer: i32, priority: i16, flags: u64) -> isize;
    fn WinDivertRecv(
        handle: isize,
        p_packet: *mut u8,
        packet_len: u32,
        p_recv_len: *mut u32,
        p_addr: *mut WinDivertAddress,
    ) -> i32;
    fn WinDivertSend(
        handle: isize,
        p_packet: *const u8,
        packet_len: u32,
        p_send_len: *mut u32,
        p_addr: *const WinDivertAddress,
    ) -> i32;
    fn WinDivertHelperCalcChecksums(
        p_packet: *mut u8,
        packet_len: u32,
        p_addr: *mut WinDivertAddress,
        flags: u64,
    ) -> i32;
    fn WinDivertClose(handle: isize) -> i32;
}

const WINDIVERT_LAYER_NETWORK: i32 = 0;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct WinDivertAddress {
    pub timestamp: i64,
    pub layer_event_flags: u32, // Bitfields: Layer(8), Event(8), Sniffed(1), Outbound(1), Loopback(1), Impostor(1), IPv6(1), IPChecksum(1), TCPChecksum(1), UDPChecksum(1)
    pub reserved: u32,
    pub union_data: [u8; 64],
}

impl Default for WinDivertAddress {
    fn default() -> Self {
        Self {
            timestamp: 0,
            layer_event_flags: 0,
            reserved: 0,
            union_data: [0u8; 64],
        }
    }
}

impl WinDivertAddress {
    #[inline]
    pub fn set_outbound(&mut self, outbound: bool) {
        // Outbound bit is at bit offset 17 in layer_event_flags
        if outbound {
            self.layer_event_flags |= 1 << 17;
        } else {
            self.layer_event_flags &= !(1 << 17);
        }
    }
}

#[repr(C, packed)]
struct Ipv4Header {
    ver_ihl: u8,
    tos: u8,
    total_len: u16,
    id: u16,
    frag_off: u16,
    ttl: u8,
    protocol: u8,
    checksum: u16,
    src_addr: u32,
    dst_addr: u32,
}

#[repr(C, packed)]
struct TcpHeader {
    src_port: u16,
    dst_port: u16,
    seq_num: u32,
    ack_num: u32,
    data_off_reserved: u8,
    flags: u8,
    window: u16,
    checksum: u16,
    urgent_ptr: u16,
}

const TCP_FLAG_SYN: u8 = 0x02;
#[allow(dead_code)]
const TCP_FLAG_FIN: u8 = 0x01;
const TCP_FLAG_RST: u8 = 0x04;

/// Stores original destination metadata for a redirected `target applications` TCP socket
#[derive(Debug, Clone, Copy)]
pub struct NatSession {
    pub client_ip: Ipv4Addr,
    pub client_port: u16,
    pub original_dst_ip: Ipv4Addr,
    pub original_dst_port: u16,
    pub last_seen: Instant,
}

/// Transparently intercepts `target applications` TCP port 80/443 connections and routes them
/// to the local OmniLink multi-NIC dispatcher.
pub struct LauncherInterceptor {
    proxy_port: u16,
    nat_table: Arc<DashMap<(Ipv4Addr, u16), NatSession>>,
    target_pids: Arc<RwLock<HashSet<u32>>>,
    target_names: Arc<RwLock<Vec<String>>>,
    running: Arc<AtomicBool>,
}

impl LauncherInterceptor {
    pub fn new(proxy_port: u16) -> Self {
        Self {
            proxy_port,
            nat_table: Arc::new(DashMap::with_capacity(1024)),
            target_pids: Arc::new(RwLock::new(HashSet::new())),
            target_names: Arc::new(RwLock::new(Vec::new())),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn running_targets(&self) -> String {
        self.target_names
            .read()
            .map(|names| names.join(", "))
            .unwrap_or_default()
    }

    /// Returns whether the PID monitor currently sees the launcher client process.
    pub fn is_target_process_running(&self) -> bool {
        self.target_pids
            .read()
            .map(|pids| !pids.is_empty())
            .unwrap_or(false)
    }

    /// Called by `src/dispatcher.rs` when a new connection arrives on `0.0.0.0:19080`
    /// to retrieve the remote address requested by the original launcher socket.
    pub fn get_original_destination(&self, client: SocketAddr) -> Option<SocketAddr> {
        let std::net::IpAddr::V4(ip) = client.ip() else {
            return None;
        };
        self.nat_table.get(&(ip, client.port())).map(|entry| {
            SocketAddr::V4(SocketAddrV4::new(
                entry.original_dst_ip,
                entry.original_dst_port,
            ))
        })
    }

    /// Starts the background PID refresher and WinDivert packet redirection loop.
    pub fn start(&self) -> io::Result<()> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        // 1. Spawn background thread to refresh `target applications` PIDs and prune stale NAT entries
        let pids_clone = Arc::clone(&self.target_pids);
        let names_clone = Arc::clone(&self.target_names);
        let nat_clone = Arc::clone(&self.nat_table);
        std::thread::Builder::new()
            .name("omnilink-pid-monitor".into())
            .spawn(move || {
                // Keep launcher process status available even if WinDivert cannot start.
                // The app exits as a whole when the tray command quits.
                loop {
                    let targets = crate::launcher_profiles::target_names();
                    let names: Vec<&str> = targets.iter().map(String::as_str).collect();
                    let (latest_pids, running_names) = find_target_processes(&names);
                    if let Ok(mut guard) = names_clone.write() {
                        *guard = running_names;
                    }
                    if let Ok(mut guard) = pids_clone.write() {
                        *guard = latest_pids;
                    }
                    // Retain active sockets regardless of their age. If querying Windows
                    // fails, do not destroy connection state based on an unknown snapshot.
                    let now = Instant::now();
                    if let Ok(rows) = tcp_rows() {
                        nat_clone.retain(|_, session| retain_session(session, &rows, now));
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            })?;

        // 2. Open WinDivert handle capturing outbound TCP 80/443 and outbound replies from proxy_port
        let filter = format!(
            "outbound and ip and tcp and (tcp.DstPort == 80 or tcp.DstPort == 443 or tcp.SrcPort == {})",
            self.proxy_port
        );
        let c_filter = CString::new(filter).unwrap();
        let handle = unsafe { WinDivertOpen(c_filter.as_ptr(), WINDIVERT_LAYER_NETWORK, 0, 0) };

        if handle == (INVALID_HANDLE_VALUE as isize) || handle <= 0 {
            self.running.store(false, Ordering::SeqCst);
            return Err(io::Error::last_os_error());
        }

        let proxy_port = self.proxy_port;
        let nat_table = Arc::clone(&self.nat_table);
        let target_pids = Arc::clone(&self.target_pids);
        let running = Arc::clone(&self.running);

        std::thread::Builder::new()
            .name("omnilink-windivert-loop".into())
            .spawn(move || {
                let mut packet = vec![0u8; 65535];
                let mut recv_len: u32 = 0;
                let mut send_len: u32 = 0;
                let mut addr = WinDivertAddress::default();

                while running.load(Ordering::Relaxed) {
                    let ok = unsafe {
                        WinDivertRecv(
                            handle,
                            packet.as_mut_ptr(),
                            packet.len() as u32,
                            &mut recv_len,
                            &mut addr,
                        )
                    };
                    if ok == 0 {
                        running.store(false, Ordering::Relaxed);
                        break;
                    }

                    let pkt_slice = &mut packet[..recv_len as usize];
                    Self::process_packet(
                        pkt_slice,
                        &mut addr,
                        proxy_port,
                        &nat_table,
                        &target_pids,
                    );

                    unsafe {
                        WinDivertHelperCalcChecksums(
                            pkt_slice.as_mut_ptr(),
                            recv_len,
                            &mut addr,
                            0,
                        );
                        if WinDivertSend(handle, pkt_slice.as_ptr(), recv_len, &mut send_len, &addr)
                            == 0
                        {
                            running.store(false, Ordering::Relaxed);
                            break;
                        }
                    }
                }

                unsafe {
                    WinDivertClose(handle);
                }
            })?;

        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    fn process_packet(
        packet: &mut [u8],
        addr: &mut WinDivertAddress,
        proxy_port: u16,
        nat_table: &DashMap<(Ipv4Addr, u16), NatSession>,
        target_pids: &RwLock<HashSet<u32>>,
    ) {
        if packet.len() < size_of::<Ipv4Header>() {
            return;
        }

        let ip_hdr = unsafe { &mut *(packet.as_mut_ptr() as *mut Ipv4Header) };
        let ihl = ((ip_hdr.ver_ihl & 0x0F) as usize) * 4;
        if ip_hdr.ver_ihl >> 4 != 4
            || ihl < 20
            || ip_hdr.protocol != 6
            || packet.len() < ihl + size_of::<TcpHeader>()
        {
            return;
        }

        let tcp_hdr = unsafe { &mut *(packet.as_mut_ptr().add(ihl) as *mut TcpHeader) };

        let src_port = u16::from_be(tcp_hdr.src_port);
        let dst_port = u16::from_be(tcp_hdr.dst_port);
        let src_ip = Ipv4Addr::from(u32::from_be(ip_hdr.src_addr));
        let dst_ip = Ipv4Addr::from(u32::from_be(ip_hdr.dst_addr));

        // CASE A: Reply packet coming from our local Dispatcher (src_port == proxy_port) back to target applications
        if src_port == proxy_port {
            if let Some(mut session) = nat_table.get_mut(&(dst_ip, dst_port)) {
                if dst_ip != session.client_ip {
                    return;
                }
                session.last_seen = Instant::now();
                // Rewrite source IP/Port back to original launcher CDN IP/Port
                ip_hdr.src_addr = u32::from(session.original_dst_ip).to_be();
                ip_hdr.dst_addr = u32::from(session.client_ip).to_be();
                tcp_hdr.src_port = session.original_dst_port.to_be();

                // Inject inbound back into Windows TCP stack for target applications
                addr.set_outbound(false);
            }
            return;
        }

        // CASE B: Outbound packet to TCP 80/443
        if dst_port == 80 || dst_port == 443 {
            // Check if this source port is already tracked in our NAT table
            let is_tracked = if let Some(mut session) =
                nat_table.get_mut(&(src_ip, src_port)).filter(|s| {
                    s.client_ip == src_ip
                        && s.original_dst_ip == dst_ip
                        && s.original_dst_port == dst_port
                }) {
                // Only redirect the original target applications socket, NEVER the dispatcher's own upstream sockets!
                session.last_seen = Instant::now();
                true
            } else if (tcp_hdr.flags & TCP_FLAG_SYN) != 0 {
                // A shared local endpoint cannot map two destinations to this one
                // proxy port. Leave a collision direct rather than corrupting a live flow.
                if nat_table.contains_key(&(src_ip, src_port)) {
                    return;
                }
                // New TCP SYN packet: check if the socket belongs to target applications
                let belongs_to_steam = {
                    if let Ok(pids) = target_pids.read() {
                        !pids.is_empty()
                            && tcp_rows().is_ok_and(|rows| {
                                rows.iter().any(|row| {
                                    pids.contains(&row.dwOwningPid)
                                        && row_matches(row, src_ip, src_port, dst_ip, dst_port)
                                })
                            })
                    } else {
                        false
                    }
                };

                if belongs_to_steam {
                    nat_table.insert(
                        (src_ip, src_port),
                        NatSession {
                            client_ip: src_ip,
                            client_port: src_port,
                            original_dst_ip: dst_ip,
                            original_dst_port: dst_port,
                            last_seen: Instant::now(),
                        },
                    );
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if is_tracked {
                // Clean up NAT state on RST, keep briefly on FIN
                if (tcp_hdr.flags & TCP_FLAG_RST) != 0 {
                    // Still rewrite this final RST packet so the local proxy closes cleanly
                }

                // Swap destination IP to client's own adapter IP and destination port to proxy_port
                ip_hdr.dst_addr = ip_hdr.src_addr;
                tcp_hdr.dst_port = proxy_port.to_be();

                // Reinject inbound so the local dispatcher on 0.0.0.0:proxy_port receives it
                addr.set_outbound(false);
            }
        }
    }
}

/// Enumerates active Windows processes and returns all PIDs matching target executable names.
pub fn find_process_pids(target_exes: &[&str]) -> HashSet<u32> {
    find_target_processes(target_exes).0
}

fn find_target_processes(target_exes: &[&str]) -> (HashSet<u32>, Vec<String>) {
    let mut pids = HashSet::new();
    let mut names = Vec::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return (pids, names);
    }

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let exe_name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();

            if target_exes
                .iter()
                .any(|&t| t.eq_ignore_ascii_case(&exe_name))
                && entry.th32ProcessID != std::process::id()
            {
                pids.insert(entry.th32ProcessID);
                if !names.contains(&exe_name) {
                    names.push(exe_name);
                }
            }

            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe {
        CloseHandle(snapshot);
    }
    names.sort();
    (pids, names)
}

/// Queries the kernel TCP table (`GetExtendedTcpTable`) to check if `local_port` belongs to any PID in `target_pids`.
pub fn is_port_owned_by_pids(local_port: u16, target_pids: &HashSet<u32>) -> bool {
    tcp_rows().is_ok_and(|rows| {
        rows.iter().any(|row| {
            u16::from_be(row.dwLocalPort as u16) == local_port
                && target_pids.contains(&row.dwOwningPid)
        })
    })
}

fn row_matches(
    row: &MIB_TCPROW_OWNER_PID,
    local: Ipv4Addr,
    local_port: u16,
    remote: Ipv4Addr,
    remote_port: u16,
) -> bool {
    Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()) == local
        && u16::from_be(row.dwLocalPort as u16) == local_port
        && Ipv4Addr::from(row.dwRemoteAddr.to_ne_bytes()) == remote
        && u16::from_be(row.dwRemotePort as u16) == remote_port
}

fn retain_session(session: &NatSession, rows: &[MIB_TCPROW_OWNER_PID], now: Instant) -> bool {
    rows.iter().any(|row| {
        row_matches(
            row,
            session.client_ip,
            session.client_port,
            session.original_dst_ip,
            session.original_dst_port,
        )
    }) || now.duration_since(session.last_seen) < Duration::from_secs(120)
}

fn tcp_rows() -> Result<Vec<MIB_TCPROW_OWNER_PID>, u32> {
    let mut size = 16_384u32;
    for _ in 0..8 {
        let mut buffer = vec![0u8; size as usize];
        let result = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        };
        if result == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if result != NO_ERROR {
            return Err(result);
        }
        let offset = std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        if buffer.len() < offset {
            return Err(87);
        }
        let count = u32::from_ne_bytes(buffer[..4].try_into().unwrap()) as usize;
        if count > (buffer.len() - offset) / size_of::<MIB_TCPROW_OWNER_PID>() {
            return Err(87);
        }
        // Windows provides byte storage; avoid assuming its Rust Vec<u8> alignment.
        return Ok((0..count)
            .map(|index| unsafe {
                ptr::read_unaligned(
                    buffer
                        .as_ptr()
                        .add(offset + index * size_of::<MIB_TCPROW_OWNER_PID>())
                        .cast(),
                )
            })
            .collect());
    }
    Err(ERROR_INSUFFICIENT_BUFFER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn same_client_port_on_different_local_addresses_keeps_separate_destinations() {
        let interceptor = LauncherInterceptor::new(19080);
        for (local, remote) in [("192.0.2.1", "198.51.100.1"), ("192.0.2.2", "198.51.100.2")] {
            let session = NatSession {
                client_ip: local.parse().unwrap(),
                client_port: 50000,
                original_dst_ip: remote.parse().unwrap(),
                original_dst_port: 443,
                last_seen: Instant::now(),
            };
            interceptor
                .nat_table
                .insert((session.client_ip, session.client_port), session);
        }
        assert_eq!(
            interceptor.get_original_destination("192.0.2.1:50000".parse().unwrap()),
            Some("198.51.100.1:443".parse().unwrap())
        );
        assert_eq!(
            interceptor.get_original_destination("192.0.2.2:50000".parse().unwrap()),
            Some("198.51.100.2:443".parse().unwrap())
        );
    }

    #[test]
    fn active_nat_survives_ten_minutes_and_matches_full_endpoints() {
        let now = Instant::now();
        let session = NatSession {
            client_ip: Ipv4Addr::new(192, 0, 2, 1),
            client_port: 50000,
            original_dst_ip: Ipv4Addr::new(198, 51, 100, 1),
            original_dst_port: 443,
            last_seen: now - Duration::from_secs(1200),
        };
        let mut row: MIB_TCPROW_OWNER_PID = unsafe { std::mem::zeroed() };
        row.dwLocalAddr = u32::from_ne_bytes(session.client_ip.octets());
        row.dwLocalPort = session.client_port.to_be() as u32;
        row.dwRemoteAddr = u32::from_ne_bytes(session.original_dst_ip.octets());
        row.dwRemotePort = session.original_dst_port.to_be() as u32;
        assert!(retain_session(&session, &[row], now));
        row.dwRemotePort = 80u16.to_be() as u32;
        assert!(!retain_session(&session, &[row], now));
        assert!(!retain_session(&session, &[], now));
    }

    #[test]
    fn test_is_port_owned_by_current_pid() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = TcpStream::connect(format!("127.0.0.1:{}", port)).unwrap();
        let client_port = client.local_addr().unwrap().port();
        let pid = std::process::id();
        let mut pids = HashSet::new();
        pids.insert(pid);
        assert!(
            is_port_owned_by_pids(client_port, &pids),
            "Should detect client port {} owned by pid {}",
            client_port,
            pid
        );
    }
}
