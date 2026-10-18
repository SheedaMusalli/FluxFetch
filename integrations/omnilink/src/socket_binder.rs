use socket2::{Domain, Protocol, Socket, Type};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::os::windows::io::AsRawSocket;
use tokio::net::TcpStream;
use windows_sys::Win32::Networking::WinSock::{setsockopt, IPPROTO_IP, IP_UNICAST_IF};

/// Creates an async TcpStream strictly bound to a specific Windows Network Adapter
pub async fn connect_via_adapter(
    target: SocketAddr,
    adapter_ip: Ipv4Addr,
    if_index: u32,
) -> io::Result<TcpStream> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_nonblocking(true)?;
    socket.set_nodelay(true)?;

    // 1. Bind to the adapter's local IPv4 address (ephemeral port 0)
    let local_addr = SocketAddrV4::new(adapter_ip, 0);
    socket.bind(&local_addr.into())?;

    // 2. CRITICAL: Force Windows routing engine to use this hardware interface index
    // IP_UNICAST_IF requires the interface index in network byte order (big-endian)
    let if_index_be = if_index.to_be();
    let raw_sock = socket.as_raw_socket() as usize;
    let ret = unsafe {
        setsockopt(
            raw_sock,
            IPPROTO_IP,
            IP_UNICAST_IF,
            &if_index_be as *const u32 as *const u8,
            std::mem::size_of::<u32>() as i32,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }

    // 3. Convert to Tokio TcpSocket and connect asynchronously
    let std_stream: std::net::TcpStream = socket.into();
    let tokio_sock = tokio::net::TcpSocket::from_std_stream(std_stream);
    tokio_sock.connect(target).await
}
