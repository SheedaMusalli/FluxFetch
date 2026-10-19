use std::ffi::CStr;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GetIfEntry2, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_INCLUDE_PREFIX,
    IF_TYPE_IEEE80211, IF_TYPE_PROP_VIRTUAL, IF_TYPE_SOFTWARE_LOOPBACK, IF_TYPE_TUNNEL,
    IP_ADAPTER_ADDRESSES_LH, MIB_IF_ROW2,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

/// Represents a physical or tethered IPv4 network interface capable of routing traffic to launcher CDNs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkAdapter {
    /// Windows IPv4 Interface Index required for `setsockopt(..., IP_UNICAST_IF, ...)`
    pub if_index: u32,
    /// Permanent internal Windows adapter GUID/Name
    pub adapter_name: String,
    /// User-visible name in Windows Network Connections (e.g., "Ethernet", "Wi-Fi")
    pub friendly_name: String,
    /// Hardware description (e.g., "Intel(R) Ethernet Controller I225-V")
    pub description: String,
    /// Primary local IPv4 address assigned to this adapter
    pub ipv4: Ipv4Addr,
    /// Default IPv4 gateway address for this adapter
    pub gateway_ipv4: Ipv4Addr,
    /// Reported receive link speed in bits per second
    pub rx_link_speed_bps: u64,
    /// Reported transmit link speed in bits per second
    pub tx_link_speed_bps: u64,
    /// True if wireless (Wi-Fi), false if wired/RNDIS USB tether
    pub is_wireless: bool,
}

impl NetworkAdapter {
    /// Formatted label for the System Tray menu
    pub fn tray_label(&self, current_mbps: f64) -> String {
        format!(
            "{} ({}) - {} [{:.1} Mbps]",
            self.friendly_name, self.description, self.ipv4, current_mbps
        )
    }
}

/// Discovers all active, routable IPv4 network adapters on the system.
pub fn discover_routable_adapters() -> io::Result<Vec<NetworkAdapter>> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_INCLUDE_PREFIX;
    let family = AF_INET as u32;

    // Start with a 16 KB buffer as recommended by MSDN to avoid an extra syscall in most cases
    let mut buf_len: u32 = 16 * 1024;
    let mut buffer: Vec<u8> = vec![0u8; buf_len as usize];

    loop {
        let adapter_ptr = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let ret = unsafe {
            GetAdaptersAddresses(family, flags, ptr::null_mut(), adapter_ptr, &mut buf_len)
        };

        if ret == ERROR_SUCCESS {
            break;
        } else if ret == ERROR_BUFFER_OVERFLOW {
            buffer.resize(buf_len as usize, 0u8);
            continue;
        } else {
            return Err(io::Error::from_raw_os_error(ret as i32));
        }
    }

    let mut adapters = Vec::new();
    let mut current_ptr = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;

    while !current_ptr.is_null() {
        let adapter = unsafe { &*current_ptr };

        if let Some(parsed) = unsafe { parse_adapter(adapter) } {
            adapters.push(parsed);
        }

        current_ptr = adapter.Next;
    }

    // Sort adapters deterministically by interface index
    adapters.sort_by_key(|a| a.if_index);
    Ok(adapters)
}

unsafe fn parse_adapter(adapter: &IP_ADAPTER_ADDRESSES_LH) -> Option<NetworkAdapter> {
    // 1. Must be operationally UP
    if adapter.OperStatus != IfOperStatusUp {
        return None;
    }

    // 2. Filter out software loopback, tunnels, and pure virtual internal switches
    let if_type = adapter.IfType;
    if if_type == IF_TYPE_SOFTWARE_LOOPBACK
        || if_type == IF_TYPE_TUNNEL
        || if_type == IF_TYPE_PROP_VIRTUAL
    {
        return None;
    }

    // 3. Extract the IPv4 Interface Index (IfIndex)
    let if_index = adapter.Anonymous1.Anonymous.IfIndex;
    if if_index == 0 {
        return None;
    }

    // 4. Extract FriendlyName and Description from null-terminated UTF-16 pointers
    let friendly_name = pwstr_to_string(adapter.FriendlyName)?;
    let description = pwstr_to_string(adapter.Description)?;
    let adapter_name = pstr_to_string(adapter.AdapterName).unwrap_or_default();

    // Ignore known virtual/VPN/container interfaces that shouldn't be bonded with physical WANs
    let lower_desc = description.to_lowercase();
    let lower_name = friendly_name.to_lowercase();
    if lower_desc.contains("hyper-v")
        || lower_desc.contains("vmware")
        || lower_desc.contains("virtualbox")
        || lower_desc.contains("wintun")
        || lower_desc.contains("tap-windows")
        || lower_desc.contains("radmin")
        || lower_desc.contains("hamachi")
        || lower_desc.contains("tailscale")
        || lower_desc.contains("zerotier")
        || lower_desc.contains("wireguard")
        || lower_desc.contains("nordlynx")
        || lower_desc.contains("openvpn")
        || lower_name.contains("vethernet")
        || lower_name.contains("wsl")
        || lower_name.contains("radmin")
        || lower_name.contains("hamachi")
        || lower_name.contains("tailscale")
        || lower_name.contains("zerotier")
    {
        return None;
    }

    // 5. Extract first valid non-loopback, non-APIPA Unicast IPv4 address
    let ipv4 = extract_first_ipv4_unicast(adapter)?;
    if ipv4.is_loopback() || ipv4.is_link_local() || ipv4.is_unspecified() {
        return None;
    }

    // 6. Require a valid IPv4 Default Gateway (crucial for distinguishing WAN links from LAN-only NICs)
    let gateway_ipv4 = extract_first_ipv4_gateway(adapter)?;
    if gateway_ipv4.is_unspecified() {
        return None;
    }

    Some(NetworkAdapter {
        if_index,
        adapter_name,
        friendly_name,
        description,
        ipv4,
        gateway_ipv4,
        rx_link_speed_bps: adapter.ReceiveLinkSpeed,
        tx_link_speed_bps: adapter.TransmitLinkSpeed,
        is_wireless: if_type == IF_TYPE_IEEE80211,
    })
}

unsafe fn extract_first_ipv4_unicast(adapter: &IP_ADAPTER_ADDRESSES_LH) -> Option<Ipv4Addr> {
    let mut unicast_ptr = adapter.FirstUnicastAddress;
    while !unicast_ptr.is_null() {
        let unicast = &*unicast_ptr;
        if let Some(ip) = sockaddr_to_ipv4(unicast.Address.lpSockaddr as *const SOCKADDR_IN) {
            if !ip.is_loopback() && !ip.is_link_local() {
                return Some(ip);
            }
        }
        unicast_ptr = unicast.Next;
    }
    None
}

unsafe fn extract_first_ipv4_gateway(adapter: &IP_ADAPTER_ADDRESSES_LH) -> Option<Ipv4Addr> {
    let mut gw_ptr = adapter.FirstGatewayAddress;
    while !gw_ptr.is_null() {
        let gw = &*gw_ptr;
        if let Some(ip) = sockaddr_to_ipv4(gw.Address.lpSockaddr as *const SOCKADDR_IN) {
            if !ip.is_unspecified() {
                return Some(ip);
            }
        }
        gw_ptr = gw.Next;
    }
    None
}

unsafe fn sockaddr_to_ipv4(sockaddr_ptr: *const SOCKADDR_IN) -> Option<Ipv4Addr> {
    if sockaddr_ptr.is_null() {
        return None;
    }
    let sockaddr = &*sockaddr_ptr;
    if sockaddr.sin_family != AF_INET {
        return None;
    }
    // sin_addr.S_un.S_addr is in network byte order (big-endian)
    let raw_ip = u32::from_be(sockaddr.sin_addr.S_un.S_addr);
    Some(Ipv4Addr::from(raw_ip))
}

unsafe fn pwstr_to_string(ptr: *const u16) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    Some(String::from_utf16_lossy(slice))
}

unsafe fn pstr_to_string(ptr: *const u8) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr as *const i8)
        .to_str()
        .ok()
        .map(|s| s.to_owned())
}

/// Probes whether an adapter actually has external internet connectivity to Valve/Cloudflare edges
/// by binding a socket directly to its `IfIndex` and timing a TCP handshake.
pub async fn probe_adapter_health(
    adapter: &NetworkAdapter,
    probe_target: SocketAddr,
    timeout: Duration,
) -> Option<Duration> {
    let start = std::time::Instant::now();
    let connect_fut =
        crate::socket_binder::connect_via_adapter(probe_target, adapter.ipv4, adapter.if_index);

    match tokio::time::timeout(timeout, connect_fut).await {
        Ok(Ok(_stream)) => Some(start.elapsed()),
        _ => None,
    }
}

/// Retrieves cumulative hardware received (download) and transmitted (upload) octets for an interface index.
pub fn get_adapter_octets(if_index: u32) -> Option<(u64, u64)> {
    unsafe {
        let mut row: MIB_IF_ROW2 = std::mem::zeroed();
        row.InterfaceIndex = if_index;
        if GetIfEntry2(&mut row) == 0 {
            Some((row.InOctets, row.OutOctets))
        } else {
            None
        }
    }
}
