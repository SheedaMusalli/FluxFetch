use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen,
    CreateRoundRectRgn, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect,
    GetStockObject, InvalidateRect, RoundRect, SelectObject, SetBkMode, SetTextColor, SetWindowRgn,
    CLEARTYPE_QUALITY, DEFAULT_CHARSET, DT_CENTER, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE,
    DT_VCENTER, FW_BOLD, FW_NORMAL, HDC, HFONT, NULL_BRUSH, PAINTSTRUCT, PS_SOLID, SRCCOPY,
    TRANSPARENT,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DispatchMessageW,
    GetClientRect, GetCursorPos, GetMessageW, GetSystemMetrics, LoadCursorW, PostMessageW,
    RegisterClassExW, SendMessageW, SetTimer, SetWindowPos, ShowWindow, TrackPopupMenu,
    TranslateMessage, HTCAPTION, HWND_TOPMOST, IDC_ARROW, MF_STRING, SM_CXSCREEN, SWP_NOMOVE,
    SWP_NOSIZE, SW_HIDE, SW_SHOW, TPM_RIGHTBUTTON, WM_CREATE, WM_DESTROY, WM_LBUTTONDOWN,
    WM_NCLBUTTONDOWN, WM_PAINT, WM_RBUTTONUP, WM_TIMER, WM_USER, WNDCLASSEXW, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

use crate::interceptor::LauncherInterceptor;
use crate::load_balancer::LoadBalancer;

#[link(name = "user32")]
extern "system" {
    fn SetProcessDpiAwarenessContext(value: isize) -> i32;
    fn GetDpiForWindow(hwnd: HWND) -> u32;
}

const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;

const BASE_WIDTH: i32 = 300;
const BASE_ROW_HEIGHT: i32 = 84;
const BASE_HEADER_HEIGHT: i32 = 28;
const BASE_SUMMARY_HEIGHT: i32 = 76;
const BASE_DETAILS_HEADER_HEIGHT: i32 = 28;
const BASE_FOOTER_HEIGHT: i32 = 20;
const BASE_PADDING: i32 = 8;
const BASE_CORNER_RADIUS: i32 = 14;

const TIMER_REFRESH_ID: usize = 1001;
const WM_SET_VISIBILITY: u32 = WM_USER + 101;
const WM_RESET_POSITION: u32 = WM_USER + 102;
const WM_DPICHANGED: u32 = 0x02E0;

const MENU_CMD_HIDE: usize = 2001;
const MENU_CMD_RESET_POS: usize = 2002;

/// Thread-safe controller for the desktop OmniLink overlay.
pub struct OverlayController {
    hwnd: AtomicIsize,
    visible: AtomicBool,
    load_balancer: Arc<LoadBalancer>,
    interceptor: Arc<LauncherInterceptor>,
}

impl OverlayController {
    pub fn new(
        load_balancer: Arc<LoadBalancer>,
        interceptor: Arc<LauncherInterceptor>,
    ) -> Arc<Self> {
        let controller = Arc::new(Self {
            hwnd: AtomicIsize::new(0),
            visible: AtomicBool::new(true),
            load_balancer,
            interceptor,
        });

        let ctrl_clone = Arc::clone(&controller);
        std::thread::Builder::new()
            .name("omnilink-overlay-ui".into())
            .spawn(move || {
                run_overlay_window_thread(ctrl_clone);
            })
            .expect("Failed to spawn overlay thread");

        controller
    }

    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::Relaxed)
    }

    pub fn set_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::SeqCst);
        let hwnd_raw = self.hwnd.load(Ordering::SeqCst);
        if hwnd_raw != 0 {
            let hwnd = hwnd_raw as HWND;
            unsafe {
                PostMessageW(hwnd, WM_SET_VISIBILITY, if visible { 1 } else { 0 }, 0);
            }
        }
    }

    pub fn toggle_visibility(&self) {
        let cur = self.is_visible();
        self.set_visible(!cur);
    }

    pub fn reset_position(&self) {
        let hwnd_raw = self.hwnd.load(Ordering::SeqCst);
        if hwnd_raw != 0 {
            let hwnd = hwnd_raw as HWND;
            unsafe {
                PostMessageW(hwnd, WM_RESET_POSITION, 0, 0);
            }
        }
    }
}

struct WindowThreadContext {
    controller: Arc<OverlayController>,
    dpi: u32,
    last_height: i32,
    expanded: bool,
    font_title: HFONT,
    font_bold: HFONT,
    font_normal: HFONT,
    font_small: HFONT,
    font_badge: HFONT,
    font_metric: HFONT,
}

impl WindowThreadContext {
    fn new(controller: Arc<OverlayController>, dpi: u32) -> Self {
        let dpi = if dpi > 0 { dpi } else { 96 };
        Self {
            controller,
            dpi,
            last_height: 0,
            expanded: false,
            font_title: unsafe { create_font("Segoe UI", 11, FW_BOLD, dpi) },
            font_bold: unsafe { create_font("Segoe UI", 11, FW_BOLD, dpi) },
            font_normal: unsafe { create_font("Segoe UI", 10, FW_NORMAL, dpi) },
            font_small: unsafe { create_font("Segoe UI", 8, FW_NORMAL, dpi) },
            font_badge: unsafe { create_font("Segoe UI", 7, FW_BOLD, dpi) },
            font_metric: unsafe { create_font("Segoe UI", 14, FW_BOLD, dpi) },
        }
    }

    #[inline]
    fn scale(&self, val: i32) -> i32 {
        (val * self.dpi as i32 + 48) / 96
    }

    unsafe fn update_dpi(&mut self, new_dpi: u32) {
        if new_dpi == 0 || new_dpi == self.dpi {
            return;
        }
        self.destroy_fonts();
        self.dpi = new_dpi;
        self.font_title = create_font("Segoe UI", 11, FW_BOLD, new_dpi);
        self.font_bold = create_font("Segoe UI", 11, FW_BOLD, new_dpi);
        self.font_normal = create_font("Segoe UI", 10, FW_NORMAL, new_dpi);
        self.font_small = create_font("Segoe UI", 8, FW_NORMAL, new_dpi);
        self.font_badge = create_font("Segoe UI", 7, FW_BOLD, new_dpi);
        self.font_metric = create_font("Segoe UI", 14, FW_BOLD, new_dpi);
    }

    unsafe fn destroy_fonts(&mut self) {
        if !self.font_title.is_null() {
            DeleteObject(self.font_title as *mut _);
            self.font_title = ptr::null_mut();
        }
        if !self.font_bold.is_null() {
            DeleteObject(self.font_bold as *mut _);
            self.font_bold = ptr::null_mut();
        }
        if !self.font_normal.is_null() {
            DeleteObject(self.font_normal as *mut _);
            self.font_normal = ptr::null_mut();
        }
        if !self.font_small.is_null() {
            DeleteObject(self.font_small as *mut _);
            self.font_small = ptr::null_mut();
        }
        if !self.font_badge.is_null() {
            DeleteObject(self.font_badge as *mut _);
            self.font_badge = ptr::null_mut();
        }
        if !self.font_metric.is_null() {
            DeleteObject(self.font_metric as *mut _);
            self.font_metric = ptr::null_mut();
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn overlay_height(ctx: &WindowThreadContext) -> i32 {
    let details = if ctx.expanded {
        ctx.scale(BASE_DETAILS_HEADER_HEIGHT)
            + (ctx.controller.load_balancer.snapshot_states().len().max(1) as i32)
                * ctx.scale(BASE_ROW_HEIGHT)
    } else {
        0
    };
    ctx.scale(BASE_PADDING * 2)
        + ctx.scale(BASE_HEADER_HEIGHT)
        + ctx.scale(BASE_SUMMARY_HEIGHT)
        + ctx.scale(BASE_FOOTER_HEIGHT)
        + details
}

fn run_overlay_window_thread(controller: Arc<OverlayController>) {
    // 1. Enforce PerMonitorV2 DPI awareness on this thread so Windows never bitmap-scales or blurs the window
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let class_name = to_wide("OmniLinkOverlayHUD");
    let window_title = to_wide("OmniLink Network Monitor");

    unsafe {
        let hinstance = ptr::null_mut();

        let wnd_class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(overlay_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: ptr::null_mut(),
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: ptr::null_mut(),
        };

        RegisterClassExW(&wnd_class);

        let screen_width = GetSystemMetrics(SM_CXSCREEN);
        let ctx = Box::new(WindowThreadContext::new(Arc::clone(&controller), 96));
        let ctx_ptr = Box::into_raw(ctx);

        let initial_width = (*ctx_ptr).scale(BASE_WIDTH);
        let initial_height = overlay_height(&*ctx_ptr);
        let start_x = screen_width - initial_width - (*ctx_ptr).scale(24);
        let start_y = (*ctx_ptr).scale(36);

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            window_title.as_ptr(),
            WS_POPUP,
            start_x,
            start_y,
            initial_width,
            initial_height,
            ptr::null_mut(),
            ptr::null_mut(),
            hinstance,
            ctx_ptr as *mut _,
        );

        if hwnd.is_null() {
            return;
        }

        controller.hwnd.store(hwnd as isize, Ordering::SeqCst);

        // Detect real DPI for this window and update fonts & sizes immediately
        let real_dpi = GetDpiForWindow(hwnd);
        let dpi = if real_dpi > 0 { real_dpi } else { 96 };
        let ctx_mut = &mut *ctx_ptr;
        ctx_mut.update_dpi(dpi);

        let final_width = ctx_mut.scale(BASE_WIDTH);
        let final_height = overlay_height(ctx_mut);
        ctx_mut.last_height = final_height;

        let x = screen_width - final_width - ctx_mut.scale(24);
        let y = ctx_mut.scale(36);
        SetWindowPos(hwnd, HWND_TOPMOST, x, y, final_width, final_height, 0);

        // Apply smooth window region clipping to eliminate ALL black corners
        apply_rounded_window_region(
            hwnd,
            final_width,
            final_height,
            ctx_mut.scale(BASE_CORNER_RADIUS),
        );

        // Keep pinned on top
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);

        ShowWindow(hwnd, SW_SHOW);
        SetTimer(hwnd, TIMER_REFRESH_ID, 500, None);

        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Clips the Win32 window strictly to a rounded rectangle, completely removing any black rectangular corners.
unsafe fn apply_rounded_window_region(hwnd: HWND, width: i32, height: i32, radius: i32) {
    if width > 0 && height > 0 {
        let rgn = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
        if !rgn.is_null() {
            SetWindowRgn(hwnd, rgn, 1);
        }
    }
}

unsafe fn create_font(name: &str, point_size: i32, weight: u32, dpi: u32) -> HFONT {
    let wide_name = to_wide(name);
    // Negative character height based on monitor DPI ensures maximum sharpness without blurry scaling
    let height = -((point_size * dpi as i32 + 36) / 72);
    CreateFontW(
        height,
        0,
        0,
        0,
        weight as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY as u32,
        0,
        wide_name.as_ptr(),
    )
}

unsafe extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let create_struct =
                &*(lparam as *const windows_sys::Win32::UI::WindowsAndMessaging::CREATESTRUCTW);
            let ctx_ptr = create_struct.lpCreateParams as *mut WindowThreadContext;
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                ctx_ptr as isize,
            );
            0
        }
        WM_LBUTTONDOWN => {
            let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *mut WindowThreadContext;
            if !ctx_ptr.is_null() {
                let ctx = &mut *ctx_ptr;
                let mut rect: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut rect);
                let x = (lparam as u32 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam as u32 >> 16) & 0xFFFF) as u16 as i16 as i32;
                let footer_top = rect.bottom - ctx.scale(BASE_PADDING + BASE_FOOTER_HEIGHT);
                if y >= footer_top && x >= rect.right - ctx.scale(170) {
                    ctx.expanded = !ctx.expanded;
                    let height = overlay_height(ctx);
                    ctx.last_height = height;
                    let width = ctx.scale(BASE_WIDTH);
                    SetWindowPos(hwnd, ptr::null_mut(), 0, 0, width, height, SWP_NOMOVE);
                    apply_rounded_window_region(hwnd, width, height, ctx.scale(BASE_CORNER_RADIUS));
                    InvalidateRect(hwnd, ptr::null(), 0);
                    return 0;
                }
            }
            // Drag the overlay from anywhere except its expand/collapse control.
            ReleaseCapture();
            SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as usize, 0);
            0
        }
        WM_RBUTTONUP => {
            show_overlay_context_menu(hwnd);
            0
        }
        WM_TIMER => {
            if wparam == TIMER_REFRESH_ID {
                let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                ) as *mut WindowThreadContext;

                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    let target_height = overlay_height(ctx);

                    if ctx.last_height != target_height {
                        ctx.last_height = target_height;
                        let width = ctx.scale(BASE_WIDTH);
                        let radius = ctx.scale(BASE_CORNER_RADIUS);
                        SetWindowPos(
                            hwnd,
                            ptr::null_mut(),
                            0,
                            0,
                            width,
                            target_height,
                            SWP_NOMOVE,
                        );
                        apply_rounded_window_region(hwnd, width, target_height, radius);
                    }
                }

                InvalidateRect(hwnd, ptr::null(), 0);
            }
            0
        }
        WM_DPICHANGED => {
            let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *mut WindowThreadContext;

            if !ctx_ptr.is_null() {
                let ctx = &mut *ctx_ptr;
                let new_dpi = (wparam & 0xFFFF) as u32;
                ctx.update_dpi(new_dpi);

                let width = ctx.scale(BASE_WIDTH);
                let height = overlay_height(ctx);
                ctx.last_height = height;

                let rect = &*(lparam as *const RECT);
                SetWindowPos(hwnd, HWND_TOPMOST, rect.left, rect.top, width, height, 0);
                apply_rounded_window_region(hwnd, width, height, ctx.scale(BASE_CORNER_RADIUS));
                InvalidateRect(hwnd, ptr::null(), 0);
            }
            0
        }
        WM_PAINT => {
            let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *mut WindowThreadContext;

            if !ctx_ptr.is_null() {
                let ctx = &*ctx_ptr;
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                render_overlay(hwnd, hdc, ctx);
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_SET_VISIBILITY => {
            if wparam == 1 {
                ShowWindow(hwnd, SW_SHOW);
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            } else {
                ShowWindow(hwnd, SW_HIDE);
            }
            0
        }
        WM_RESET_POSITION => {
            let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *mut WindowThreadContext;

            let screen_width = GetSystemMetrics(SM_CXSCREEN);
            let (x, y) = if !ctx_ptr.is_null() {
                let ctx = &*ctx_ptr;
                (
                    screen_width - ctx.scale(BASE_WIDTH) - ctx.scale(24),
                    ctx.scale(36),
                )
            } else {
                (screen_width - BASE_WIDTH - 24, 36)
            };
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE);
            0
        }
        WM_DESTROY => {
            let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *mut WindowThreadContext;

            if !ctx_ptr.is_null() {
                let mut ctx = Box::from_raw(ctx_ptr);
                ctx.destroy_fonts();
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn show_overlay_context_menu(hwnd: HWND) {
    let mut pt: POINT = std::mem::zeroed();
    GetCursorPos(&mut pt);

    let menu = CreatePopupMenu();
    let text_hide = to_wide("Hide Overlay (Re-enable from Tray)");
    let text_reset = to_wide("Reset Position to Top-Right");

    AppendMenuW(menu, MF_STRING, MENU_CMD_HIDE, text_hide.as_ptr());
    AppendMenuW(menu, MF_STRING, MENU_CMD_RESET_POS, text_reset.as_ptr());

    let cmd = TrackPopupMenu(
        menu,
        TPM_RIGHTBUTTON | windows_sys::Win32::UI::WindowsAndMessaging::TPM_RETURNCMD,
        pt.x,
        pt.y,
        0,
        hwnd,
        ptr::null(),
    ) as usize;

    DestroyMenu(menu);

    let ctx_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
    ) as *mut WindowThreadContext;

    if !ctx_ptr.is_null() {
        let ctx = &*ctx_ptr;
        if cmd == MENU_CMD_HIDE {
            ctx.controller.set_visible(false);
        } else if cmd == MENU_CMD_RESET_POS {
            ctx.controller.reset_position();
        }
    }
}

/// Renders a solid FluxFetch-themed overlay with only telemetry collected from launcher streams.
unsafe fn render_overlay(hwnd: HWND, hdc: HDC, ctx: &WindowThreadContext) {
    let mut client_rect: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut client_rect);
    let width = client_rect.right - client_rect.left;
    let height = client_rect.bottom - client_rect.top;
    if width <= 0 || height <= 0 {
        return;
    }

    let pad = ctx.scale(BASE_PADDING);
    let header_h = ctx.scale(BASE_HEADER_HEIGHT);
    let summary_h = ctx.scale(BASE_SUMMARY_HEIGHT);
    let row_h = ctx.scale(BASE_ROW_HEIGHT);
    let radius = ctx.scale(BASE_CORNER_RADIUS);
    let states = ctx.controller.load_balancer.snapshot_states();
    let telemetry = ctx.controller.load_balancer.telemetry();
    let launcher_running = ctx.controller.interceptor.is_target_process_running();
    let transferring = !telemetry.stale() && telemetry.observed_bps.is_some_and(|bps| bps > 0);

    let mem_dc = CreateCompatibleDC(hdc);
    let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
    let old_bmp = SelectObject(mem_dc, mem_bmp as *mut _);
    SetBkMode(mem_dc, TRANSPARENT as i32);

    // Opaque surfaces match FluxFetch's card and window colors.
    let surface = rgb(23, 25, 37);
    let card = rgb(32, 34, 49);
    let border = rgb(52, 54, 74);
    let muted = rgb(150, 155, 183);
    let foreground = rgb(240, 240, 250);
    let teal = rgb(86, 216, 189);
    let purple = rgb(169, 154, 255);
    let surface_brush = CreateSolidBrush(surface);
    FillRect(mem_dc, &client_rect, surface_brush as *mut _);
    DeleteObject(surface_brush as *mut _);

    let border_pen = CreatePen(PS_SOLID, 1, border);
    let null_brush = GetStockObject(NULL_BRUSH);
    let old_pen = SelectObject(mem_dc, border_pen as *mut _);
    let old_brush = SelectObject(mem_dc, null_brush);
    RoundRect(mem_dc, 0, 0, width, height, radius * 2, radius * 2);
    SelectObject(mem_dc, old_pen);
    SelectObject(mem_dc, old_brush);
    DeleteObject(border_pen as *mut _);

    // Brand and launcher-only status.
    draw_overlay_text(
        mem_dc,
        ctx.font_title,
        foreground,
        "FluxFetch  ·  OmniLink",
        RECT {
            left: pad,
            top: pad,
            right: width - ctx.scale(134),
            bottom: pad + header_h,
        },
        DT_LEFT,
    );

    let (status, status_fg, status_bg, status_border) =
        if telemetry.stale() || telemetry.observed_bps.is_none() {
            ("OBSERVER OFF", muted, rgb(41, 43, 62), rgb(68, 71, 93))
        } else if !launcher_running {
            (
                "NO LAUNCHER RUNNING",
                muted,
                rgb(41, 43, 62),
                rgb(68, 71, 93),
            )
        } else if transferring {
            ("TRANSFERRING", teal, rgb(32, 59, 59), rgb(53, 99, 92))
        } else {
            (
                "LAUNCHERS RUNNING",
                purple,
                rgb(43, 39, 70),
                rgb(82, 70, 132),
            )
        };
    let badge_rect = RECT {
        left: width - pad - ctx.scale(126),
        top: pad,
        right: width - pad,
        bottom: pad + ctx.scale(22),
    };
    draw_overlay_pill(
        mem_dc,
        badge_rect,
        status,
        status_fg,
        status_bg,
        status_border,
        ctx,
    );

    // Prominent launcher download metric.
    let summary_top = pad + header_h;
    let summary_rect = RECT {
        left: pad,
        top: summary_top,
        right: width - pad,
        bottom: summary_top + summary_h,
    };
    draw_overlay_card(mem_dc, summary_rect, card, border, ctx.scale(12));
    let accent_rect = RECT {
        left: summary_rect.left + ctx.scale(1),
        top: summary_rect.top + ctx.scale(9),
        right: summary_rect.left + ctx.scale(4),
        bottom: summary_rect.bottom - ctx.scale(9),
    };
    let accent_brush = CreateSolidBrush(if transferring { teal } else { purple });
    FillRect(mem_dc, &accent_rect, accent_brush as *mut _);
    DeleteObject(accent_brush as *mut _);
    draw_overlay_text(
        mem_dc,
        ctx.font_small,
        muted,
        "LAUNCHER NETWORK RX",
        RECT {
            left: summary_rect.left + ctx.scale(13),
            top: summary_rect.top + ctx.scale(5),
            right: summary_rect.right - ctx.scale(12),
            bottom: summary_rect.top + ctx.scale(20),
        },
        DT_LEFT,
    );
    draw_overlay_text(
        mem_dc,
        ctx.font_metric,
        if transferring { teal } else { foreground },
        &telemetry.observed_text(),
        RECT {
            left: summary_rect.left + ctx.scale(13),
            top: summary_rect.top + ctx.scale(20),
            right: summary_rect.right - ctx.scale(12),
            bottom: summary_rect.bottom - ctx.scale(23),
        },
        DT_LEFT,
    );

    draw_overlay_text(
        mem_dc,
        ctx.font_small,
        muted,
        &format!("Routed payload: {}", telemetry.routed_text()),
        RECT {
            left: summary_rect.left + ctx.scale(13),
            top: summary_rect.bottom - ctx.scale(23),
            right: summary_rect.right - ctx.scale(10),
            bottom: summary_rect.bottom - ctx.scale(3),
        },
        DT_LEFT,
    );

    if ctx.expanded {
        let details_top = summary_rect.bottom;
        let active_connections: usize = telemetry.adapters.iter().map(|a| a.connections).sum();
        draw_overlay_text(
            mem_dc,
            ctx.font_small,
            muted,
            &format!("ROUTED CONNECTIONS  ·  {} ACTIVE", active_connections),
            RECT {
                left: pad + ctx.scale(2),
                top: details_top,
                right: width - pad - ctx.scale(112),
                bottom: details_top + ctx.scale(BASE_DETAILS_HEADER_HEIGHT),
            },
            DT_LEFT,
        );

        let routing_text = if telemetry.stale() {
            "UNAVAILABLE"
        } else {
            telemetry.routing_status
        };
        draw_overlay_text(
            mem_dc,
            ctx.font_small,
            muted,
            routing_text,
            RECT {
                left: width - pad - ctx.scale(110),
                top: details_top,
                right: width - pad - ctx.scale(2),
                bottom: details_top + ctx.scale(BASE_DETAILS_HEADER_HEIGHT),
            },
            DT_RIGHT,
        );

        let mut row_top = details_top + ctx.scale(BASE_DETAILS_HEADER_HEIGHT);
        for state in &states {
            let sample = telemetry
                .adapters
                .iter()
                .find(|a| a.if_index == state.adapter.if_index);
            let row = RECT {
                left: pad,
                top: row_top,
                right: width - pad,
                bottom: row_top + row_h,
            };
            draw_overlay_card(mem_dc, row, card, border, ctx.scale(9));

            let dot_color = if state.enabled.load(Ordering::Relaxed) {
                purple
            } else {
                muted
            };
            let dot_brush = CreateSolidBrush(dot_color);
            let dot_x = row.left + ctx.scale(12);
            let dot_y = row.top + (row_h - ctx.scale(7)) / 2;
            // Fill the small marker with a solid brush, then restore the previous GDI brush.
            let old_dot_brush = SelectObject(mem_dc, dot_brush as *mut _);
            windows_sys::Win32::Graphics::Gdi::Ellipse(
                mem_dc,
                dot_x,
                dot_y,
                dot_x + ctx.scale(7),
                dot_y + ctx.scale(7),
            );
            SelectObject(mem_dc, old_dot_brush);
            DeleteObject(dot_brush as *mut _);

            let enabled = state.enabled.load(Ordering::Relaxed);
            let healthy = state.healthy.load(Ordering::Relaxed);
            let connections = sample.map_or(0, |a| a.connections);
            let state_label = if !enabled {
                "PAUSED"
            } else if !healthy {
                "DEGRADED"
            } else {
                "READY"
            };
            let text_left = row.left + ctx.scale(27);
            let text_right = row.right - ctx.scale(10);

            draw_overlay_text(
                mem_dc,
                ctx.font_normal,
                foreground,
                &state.adapter.friendly_name,
                RECT {
                    left: text_left,
                    top: row.top + ctx.scale(1),
                    right: row.right - ctx.scale(138),
                    bottom: row.top + ctx.scale(21),
                },
                DT_LEFT,
            );
            draw_overlay_text(
                mem_dc,
                ctx.font_small,
                teal,
                &format!(
                    "Routed {}",
                    crate::telemetry::format_rate(if telemetry.stale() {
                        None
                    } else {
                        sample.map(|a| a.routed_bps)
                    })
                ),
                RECT {
                    left: row.right - ctx.scale(140),
                    top: row.top + ctx.scale(1),
                    right: text_right,
                    bottom: row.top + ctx.scale(21),
                },
                DT_RIGHT,
            );

            draw_overlay_text(
                mem_dc,
                ctx.font_small,
                muted,
                &format!(
                    "Adapter RX (all apps): {}",
                    crate::telemetry::format_rate(if telemetry.stale() {
                        None
                    } else {
                        sample.and_then(|a| a.network_rx_bps)
                    })
                ),
                RECT {
                    left: text_left,
                    top: row.top + ctx.scale(40),
                    right: text_right,
                    bottom: row.top + ctx.scale(57),
                },
                DT_LEFT,
            );

            draw_overlay_text(
                mem_dc,
                ctx.font_small,
                muted,
                &format!(
                    "IP {}  ·  GW {}",
                    state.adapter.ipv4, state.adapter.gateway_ipv4
                ),
                RECT {
                    left: text_left,
                    top: row.top + ctx.scale(22),
                    right: text_right,
                    bottom: row.top + ctx.scale(40),
                },
                DT_LEFT,
            );

            draw_overlay_text(
                mem_dc,
                ctx.font_small,
                muted,
                &format!(
                    "LINK ↓ {}  ↑ {}  ·  {} conn  ·  {}",
                    format_link_speed(state.adapter.rx_link_speed_bps),
                    format_link_speed(state.adapter.tx_link_speed_bps),
                    connections,
                    state_label
                ),
                RECT {
                    left: text_left,
                    top: row.top + ctx.scale(58),
                    right: text_right,
                    bottom: row.bottom - ctx.scale(2),
                },
                DT_LEFT,
            );
            row_top += row_h;
        }
    }

    // Clickable disclosure control at the bottom-right corner.
    let footer_text = format!(
        "{}  ·  {} NETWORKS",
        if ctx.expanded { "LESS" } else { "MORE" },
        states.len()
    );
    let footer_top = height - pad - ctx.scale(BASE_FOOTER_HEIGHT);
    let footer_rect = RECT {
        left: width - pad - ctx.scale(158),
        top: footer_top,
        right: width - pad,
        bottom: height - pad,
    };
    draw_overlay_text(
        mem_dc,
        ctx.font_small,
        purple,
        &footer_text,
        footer_rect,
        DT_RIGHT,
    );

    BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);
    SelectObject(mem_dc, old_bmp);
    DeleteObject(mem_bmp as *mut _);
    DeleteDC(mem_dc);
}

unsafe fn draw_overlay_text(
    dc: HDC,
    font: HFONT,
    color: u32,
    text: &str,
    mut rect: RECT,
    align: u32,
) {
    SelectObject(dc, font as *mut _);
    SetTextColor(dc, color);
    let wide = to_wide(text);
    DrawTextW(
        dc,
        wide.as_ptr(),
        -1,
        &mut rect,
        align | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
}

unsafe fn draw_overlay_card(dc: HDC, rect: RECT, fill: u32, border: u32, radius: i32) {
    let brush = CreateSolidBrush(fill);
    let pen = CreatePen(PS_SOLID, 1, border);
    let old_brush = SelectObject(dc, brush as *mut _);
    let old_pen = SelectObject(dc, pen as *mut _);
    RoundRect(
        dc,
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        radius * 2,
        radius * 2,
    );
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(brush as *mut _);
    DeleteObject(pen as *mut _);
}

unsafe fn draw_overlay_pill(
    dc: HDC,
    rect: RECT,
    text: &str,
    foreground: u32,
    background: u32,
    border: u32,
    ctx: &WindowThreadContext,
) {
    draw_overlay_card(dc, rect, background, border, ctx.scale(12));
    draw_overlay_text(dc, ctx.font_badge, foreground, text, rect, DT_CENTER);
}

fn format_link_speed(bits_per_second: u64) -> String {
    let mbps = bits_per_second as f64 / 1_000_000.0;
    if mbps >= 1000.0 {
        format!("{:.1}G", mbps / 1000.0)
    } else if mbps >= 1.0 {
        format!("{:.0}M", mbps)
    } else {
        "—".to_string()
    }
}

#[inline]
fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}
