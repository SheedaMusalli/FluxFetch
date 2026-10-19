use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use crate::interceptor::SteamInterceptor;
use crate::load_balancer::{AdapterState, LoadBalancer};
use crate::socket_binder::connect_via_adapter;

const STALL_TIMEOUT: Duration = Duration::from_millis(3500);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2500);

/// Wraps an upstream `TcpStream` to count bytes in real-time with zero lock contention
/// and decrement active connection counts automatically on drop.
pub struct MeteredStream {
    inner: TcpStream,
    adapter_state: Arc<AdapterState>,
    last_activity_ms: Arc<AtomicU64>,
    epoch: Instant,
}

impl MeteredStream {
    pub fn new(
        inner: TcpStream,
        adapter_state: Arc<AdapterState>,
        last_activity_ms: Arc<AtomicU64>,
        epoch: Instant,
    ) -> Self {
        adapter_state
            .active_connections
            .fetch_add(1, Ordering::Relaxed);
        Self {
            inner,
            adapter_state,
            last_activity_ms,
            epoch,
        }
    }

    #[inline]
    fn touch(&self, bytes: usize, from_steam: bool) {
        if bytes > 0 {
            if from_steam {
                self.adapter_state.record_upload_bytes(bytes);
            } else {
                self.adapter_state.record_download_bytes(bytes);
            }
            let now_ms = self.epoch.elapsed().as_millis() as u64;
            self.last_activity_ms.store(now_ms, Ordering::Relaxed);
        }
    }
}

impl Drop for MeteredStream {
    fn drop(&mut self) {
        self.adapter_state
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
    }
}

impl AsyncRead for MeteredStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &poll {
            let transferred = buf.filled().len().saturating_sub(before);
            self.touch(transferred, false);
        }
        poll
    }
}

impl AsyncWrite for MeteredStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let poll = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &poll {
            self.touch(*n, true);
        }
        poll
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub struct BondDispatcher {
    listen_port: u16,
    load_balancer: Arc<LoadBalancer>,
    interceptor: Arc<SteamInterceptor>,
}

impl BondDispatcher {
    pub fn new(
        listen_port: u16,
        load_balancer: Arc<LoadBalancer>,
        interceptor: Arc<SteamInterceptor>,
    ) -> Self {
        Self {
            listen_port,
            load_balancer,
            interceptor,
        }
    }

    pub async fn run(&self) -> io::Result<()> {
        let bind_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, self.listen_port));
        let listener = TcpListener::bind(bind_addr).await?;

        loop {
            let (client_stream, peer_addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(_) => continue,
            };

            // The listener must bind all local addresses for transparent redirection, but the
            // fallback SOCKS proxy is intended for this PC only. Reject peers that are neither
            // loopback nor one of this machine's own adapter addresses.
            let local_peer = peer_addr.ip().is_loopback()
                || self
                    .load_balancer
                    .snapshot_states()
                    .iter()
                    .any(|state| peer_addr.ip() == std::net::IpAddr::V4(state.adapter.ipv4));
            if !local_peer {
                drop(client_stream);
                continue;
            }

            let _ = client_stream.set_nodelay(true);
            let lb = Arc::clone(&self.load_balancer);
            let interceptor = Arc::clone(&self.interceptor);

            tokio::spawn(async move {
                let _ = Self::handle_connection(client_stream, peer_addr, lb, interceptor).await;
            });
        }
    }

    async fn handle_connection(
        mut client_stream: TcpStream,
        peer_addr: SocketAddr,
        lb: Arc<LoadBalancer>,
        interceptor: Arc<SteamInterceptor>,
    ) -> io::Result<()> {
        let target_addr = if let Some(orig) = interceptor.get_original_destination(peer_addr.port())
        {
            orig
        } else {
            Self::negotiate_socks5_fallback(&mut client_stream).await?
        };

        // Try up to 2 distinct adapters in case the first choice fails its TCP handshake
        let mut upstream_info = None;
        for _attempt in 0..2 {
            let adapter_state = lb.select_best_adapter().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AddrNotAvailable,
                    "No active network adapters",
                )
            })?;

            let start = Instant::now();
            let connect_fut = connect_via_adapter(
                target_addr,
                adapter_state.adapter.ipv4,
                adapter_state.adapter.if_index,
            );

            match tokio::time::timeout(CONNECT_TIMEOUT, connect_fut).await {
                Ok(Ok(stream)) => {
                    adapter_state.record_connect_success(start.elapsed());
                    upstream_info = Some((stream, adapter_state));
                    break;
                }
                _ => {
                    adapter_state.record_failure();
                }
            }
        }

        let (upstream_tcp, adapter_state) = upstream_info.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "All selected adapters failed to connect",
            )
        })?;

        let epoch = Instant::now();
        let last_activity_ms = Arc::new(AtomicU64::new(0));
        let mut metered_upstream = MeteredStream::new(
            upstream_tcp,
            Arc::clone(&adapter_state),
            Arc::clone(&last_activity_ms),
            epoch,
        );

        let watchdog_activity = Arc::clone(&last_activity_ms);
        let watchdog_state = Arc::clone(&adapter_state);

        let copy_future = tokio::io::copy_bidirectional(&mut client_stream, &mut metered_upstream);

        let watchdog_future = async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let last = watchdog_activity.load(Ordering::Relaxed);
                let now = epoch.elapsed().as_millis() as u64;
                if now.saturating_sub(last) > STALL_TIMEOUT.as_millis() as u64 {
                    watchdog_state.record_failure();
                    return Err::<(u64, u64), io::Error>(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Adapter stalled mid-chunk; evicting socket",
                    ));
                }
            }
        };

        tokio::select! {
            res = copy_future => { res?; }
            res = watchdog_future => { res?; }
        }

        Ok(())
    }

    async fn negotiate_socks5_fallback(stream: &mut TcpStream) -> io::Result<SocketAddr> {
        let mut greeting = [0u8; 2];
        stream.read_exact(&mut greeting).await?;
        if greeting[0] != 0x05 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Not SOCKS5"));
        }
        let nmethods = greeting[1] as usize;
        let mut methods = vec![0u8; nmethods];
        stream.read_exact(&mut methods).await?;
        stream.write_all(&[0x05, 0x00]).await?;

        let mut req = [0u8; 4];
        stream.read_exact(&mut req).await?;
        if req[1] != 0x01 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Only SOCKS5 CONNECT supported",
            ));
        }

        let target_addr = match req[3] {
            0x01 => {
                let mut ip_bytes = [0u8; 4];
                let mut port_bytes = [0u8; 2];
                stream.read_exact(&mut ip_bytes).await?;
                stream.read_exact(&mut port_bytes).await?;
                let target_ip = Ipv4Addr::from(ip_bytes);
                let target_port = u16::from_be_bytes(port_bytes);
                SocketAddr::V4(SocketAddrV4::new(target_ip, target_port))
            }
            0x03 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len).await?;
                let mut domain_buf = vec![0u8; len[0] as usize];
                stream.read_exact(&mut domain_buf).await?;
                let domain = String::from_utf8(domain_buf)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                let mut port_bytes = [0u8; 2];
                stream.read_exact(&mut port_bytes).await?;
                let target_port = u16::from_be_bytes(port_bytes);

                let addr_str = format!("{}:{}", domain, target_port);
                let mut addrs = tokio::net::lookup_host(&addr_str).await?;
                addrs.find(|a| a.is_ipv4()).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "No IPv4 address found for domain")
                })?
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unsupported SOCKS5 address type",
                ));
            }
        };

        // Send SOCKS5 success reply
        stream
            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await?;

        Ok(target_addr)
    }
}
