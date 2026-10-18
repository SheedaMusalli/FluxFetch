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
    DT_VCENTER, FW_BOLD, FW_NORMAL, HDC, HFONT, NULL_BRUSH, NULL_PEN, PAINTSTRUCT, PS_SOLID,
    SRCCOPY, TRANSPARENT,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DispatchMessageW,
    GetClientRect, GetCursorPos, GetMessageW, GetSystemMetrics, LoadCursorW, PostMessageW,
    RegisterClassExW, SendMessageW, SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow,
    TrackPopupMenu, TranslateMessage, HTCAPTION, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA, MF_STRING,
    SM_CXSCREEN, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, TPM_RIGHTBUTTON, WM_CREATE, WM_DESTROY,
    WM_LBUTTONDOWN, WM_NCLBUTTONDOWN, WM_PAINT, WM_RBUTTONUP, WM_TIMER, WM_USER, WNDCLASSEXW,
    WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use crate::load_balancer::LoadBalancer;

#[link(name = "user32")]
extern "system" {
    fn SetProcessDpiAwarenessContext(value: isize) -> i32;
    fn GetDpiForWindow(hwnd: HWND) -> u32;
}

const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;

const BASE_WIDTH: i32 = 340;
const BASE_ROW_HEIGHT: i32 = 56;
const BASE_HEADER_HEIGHT: i32 = 68;
const BASE_PADDING: i32 = 12;
const BASE_CORNER_RADIUS: i32 = 14;

const TIMER_REFRESH_ID: usize = 1001;
const WM_SET_VISIBILITY: u32 = WM_USER + 101;
const WM_RESET_POSITION: u32 = WM_USER + 102;
const WM_DPICHANGED: u32 = 0x02E0;

const MENU_CMD_HIDE: usize = 2001;
const MENU_CMD_RESET_POS: usize = 2002;

/// Thread-safe controller for the desktop transparent HUD overlay
pub struct OverlayController {
    hwnd: AtomicIsize,
    visible: AtomicBool,
    load_balancer: Arc<LoadBalancer>,
}

impl OverlayController {
    pub fn new(load_balancer: Arc<LoadBalancer>) -> Arc<Self> {
        let controller = Arc::new(Self {
            hwnd: AtomicIsize::new(0),
            visible: AtomicBool::new(true),
            load_balancer,
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
    font_title: HFONT,
    font_bold: HFONT,
    font_normal: HFONT,
    font_small: HFONT,
    font_badge: HFONT,
}

impl WindowThreadContext {
    fn new(controller: Arc<OverlayController>, dpi: u32) -> Self {
        let dpi = if dpi > 0 { dpi } else { 96 };
        Self {
            controller,
            dpi,
            last_height: 0,
            font_title: unsafe { create_font("Segoe UI", 13, FW_BOLD, dpi) },
            font_bold: unsafe { create_font("Segoe UI", 11, FW_BOLD, dpi) },
            font_normal: unsafe { create_font("Segoe UI", 10, FW_NORMAL, dpi) },
            font_small: unsafe { create_font("Segoe UI", 9, FW_NORMAL, dpi) },
            font_badge: unsafe { create_font("Segoe UI", 8, FW_BOLD, dpi) },
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
        self.font_title = create_font("Segoe UI", 13, FW_BOLD, new_dpi);
        self.font_bold = create_font("Segoe UI", 11, FW_BOLD, new_dpi);
        self.font_normal = create_font("Segoe UI", 10, FW_NORMAL, new_dpi);
        self.font_small = create_font("Segoe UI", 9, FW_NORMAL, new_dpi);
        self.font_badge = create_font("Segoe UI", 8, FW_BOLD, new_dpi);
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
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
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
        let initial_height = (*ctx_ptr).scale(BASE_HEADER_HEIGHT)
            + (*ctx_ptr).scale(BASE_PADDING) * 2
            + (*ctx_ptr).scale(BASE_ROW_HEIGHT) * 2;
        let start_x = screen_width - initial_width - (*ctx_ptr).scale(24);
        let start_y = (*ctx_ptr).scale(36);

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
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
        let final_height = ctx_mut.scale(BASE_HEADER_HEIGHT)
            + ctx_mut.scale(BASE_PADDING) * 2
            + ctx_mut.scale(BASE_ROW_HEIGHT) * 2;
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

        // Set high-opacity dark glass translucency (alpha = 238 / 255 -> ~93% opacity)
        SetLayeredWindowAttributes(hwnd, 0, 238, LWA_ALPHA);

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
            // Drag the overlay across monitors smoothly
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
                    let adapter_count = ctx.controller.load_balancer.snapshot_states().len();
                    let target_height = ctx.scale(BASE_HEADER_HEIGHT)
                        + ctx.scale(BASE_PADDING) * 2
                        + (adapter_count as i32 * ctx.scale(BASE_ROW_HEIGHT))
                            .max(ctx.scale(BASE_ROW_HEIGHT));

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

                let adapter_count = ctx.controller.load_balancer.snapshot_states().len();
                let width = ctx.scale(BASE_WIDTH);
                let height = ctx.scale(BASE_HEADER_HEIGHT)
                    + ctx.scale(BASE_PADDING) * 2
                    + (adapter_count as i32 * ctx.scale(BASE_ROW_HEIGHT))
                        .max(ctx.scale(BASE_ROW_HEIGHT));
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

/// Double-buffered, crisp GDI rendering of the modern transparent HUD overlay
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
    let row_h = ctx.scale(BASE_ROW_HEIGHT);
    let radius = ctx.scale(BASE_CORNER_RADIUS);

    // 1. Offscreen memory DC for zero-flicker double buffering
    let mem_dc = CreateCompatibleDC(hdc);
    let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
    let old_bmp = SelectObject(mem_dc, mem_bmp as *mut _);

    SetBkMode(mem_dc, TRANSPARENT as i32);

    // 2. FluxFetch dark surface and border colors.
    let bg_color = rgb(23, 25, 37); // FluxFetch #171925
    let border_color = rgb(52, 54, 74); // FluxFetch #34364A
    let bg_brush = CreateSolidBrush(bg_color);
    FillRect(mem_dc, &client_rect, bg_brush as *mut _);
    DeleteObject(bg_brush as *mut _);

    // Crisp 1px perimeter border (Slate 700)
    let border_pen = CreatePen(PS_SOLID, 1, border_color);
    let null_brush = GetStockObject(NULL_BRUSH);
    let old_pen = SelectObject(mem_dc, border_pen as *mut _);
    let old_brush = SelectObject(mem_dc, null_brush);
    RoundRect(mem_dc, 0, 0, width, height, radius * 2, radius * 2);
    SelectObject(mem_dc, old_pen);
    SelectObject(mem_dc, old_brush);
    DeleteObject(border_pen as *mut _);

    // 3. Header Section
    let lb = &ctx.controller.load_balancer;
    let is_active = lb.is_bonding_enabled();
    let total_dl = lb.total_download_mbps();
    let total_ul = lb.total_upload_mbps();

    // App title keeps the feature visibly connected to FluxFetch.
    SelectObject(mem_dc, ctx.font_title as *mut _);
    SetTextColor(mem_dc, rgb(240, 240, 250));
    let mut title_rect = RECT {
        left: pad + ctx.scale(4),
        top: pad + ctx.scale(2),
        right: width - ctx.scale(95),
        bottom: pad + ctx.scale(24),
    };
    let title_text = to_wide("FluxFetch · OmniLink");
    DrawTextW(
        mem_dc,
        title_text.as_ptr(),
        -1,
        &mut title_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );

    // Status Pill Badge (Rounded pill container with colored border and background)
    let (badge_text, badge_fg, badge_bg, badge_border) = if is_active {
        (
            "● ACTIVE",
            rgb(86, 216, 189),
            rgb(32, 59, 59),
            rgb(53, 99, 92),
        )
    } else {
        (
            "● PAUSED",
            rgb(150, 155, 183),
            rgb(41, 43, 62),
            rgb(68, 71, 93),
        )
    };

    let badge_rect = RECT {
        left: width - ctx.scale(92),
        top: pad + ctx.scale(3),
        right: width - pad - ctx.scale(2),
        bottom: pad + ctx.scale(23),
    };
    let pill_brush = CreateSolidBrush(badge_bg);
    let pill_pen = CreatePen(PS_SOLID, 1, badge_border);
    let old_b = SelectObject(mem_dc, pill_brush as *mut _);
    let old_p = SelectObject(mem_dc, pill_pen as *mut _);
    RoundRect(
        mem_dc,
        badge_rect.left,
        badge_rect.top,
        badge_rect.right,
        badge_rect.bottom,
        ctx.scale(10),
        ctx.scale(10),
    );
    SelectObject(mem_dc, old_b);
    SelectObject(mem_dc, old_p);
    DeleteObject(pill_brush as *mut _);
    DeleteObject(pill_pen as *mut _);

    SelectObject(mem_dc, ctx.font_badge as *mut _);
    SetTextColor(mem_dc, badge_fg);
    let mut badge_text_rect = badge_rect;
    let badge_wide = to_wide(badge_text);
    DrawTextW(
        mem_dc,
        badge_wide.as_ptr(),
        -1,
        &mut badge_text_rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );

    // TOTAL Section
    SelectObject(mem_dc, ctx.font_small as *mut _);
    SetTextColor(mem_dc, rgb(150, 155, 183));
    let mut total_label_rect = RECT {
        left: pad + ctx.scale(4),
        top: pad + ctx.scale(28),
        right: pad + ctx.scale(70),
        bottom: pad + ctx.scale(46),
    };
    let total_label_wide = to_wide("TOTAL");
    DrawTextW(
        mem_dc,
        total_label_wide.as_ptr(),
        -1,
        &mut total_label_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );

    // Total speeds use FluxFetch's teal download and amber upload accents.
    let dl_formatted = format_speed(total_dl);
    let ul_formatted = format_speed(total_ul);
    let total_text = format!("↓ {}   ↑ {}", dl_formatted, ul_formatted);
    let total_wide = to_wide(&total_text);

    SelectObject(mem_dc, ctx.font_bold as *mut _);
    SetTextColor(mem_dc, rgb(169, 154, 255));
    let mut total_rect = RECT {
        left: pad + ctx.scale(60),
        top: pad + ctx.scale(28),
        right: width - pad - ctx.scale(4),
        bottom: pad + ctx.scale(46),
    };
    DrawTextW(
        mem_dc,
        total_wide.as_ptr(),
        -1,
        &mut total_rect,
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );

    // Divider Line
    let div_brush = CreateSolidBrush(rgb(52, 54, 74));
    let div_rect = RECT {
        left: pad,
        top: header_h - ctx.scale(2),
        right: width - pad,
        bottom: header_h - ctx.scale(1),
    };
    FillRect(mem_dc, &div_rect, div_brush as *mut _);
    DeleteObject(div_brush as *mut _);

    // 4. Per Adapter Cards
    let states = lb.snapshot_states();
    let mut cur_y = header_h + ctx.scale(6);

    for state in states {
        let is_enabled = state.enabled.load(Ordering::Relaxed);
        let dl_mbps = state.download_mbps();
        let ul_mbps = state.upload_mbps();
        let name = &state.adapter.friendly_name;
        let ip = state.adapter.ipv4.to_string();

        // Modern rounded FluxFetch card surface.
        let card_bg = rgb(32, 34, 49); // FluxFetch #202231
        let card_border = rgb(52, 54, 74); // FluxFetch #34364A
        let brush = CreateSolidBrush(card_bg);
        let pen = CreatePen(PS_SOLID, 1, card_border);
        let old_b = SelectObject(mem_dc, brush as *mut _);
        let old_p = SelectObject(mem_dc, pen as *mut _);
        RoundRect(
            mem_dc,
            pad,
            cur_y,
            width - pad,
            cur_y + row_h - ctx.scale(8),
            ctx.scale(12),
            ctx.scale(12),
        );
        SelectObject(mem_dc, old_b);
        SelectObject(mem_dc, old_p);
        DeleteObject(brush as *mut _);
        DeleteObject(pen as *mut _);

        // Circular Status Indicator Dot
        let dot_color = if is_enabled {
            rgb(86, 216, 189) // FluxFetch teal
        } else {
            rgb(86, 90, 115) // FluxFetch muted icon
        };
        let dot_brush = CreateSolidBrush(dot_color);
        let null_pen = GetStockObject(NULL_PEN);
        let old_b = SelectObject(mem_dc, dot_brush as *mut _);
        let old_p = SelectObject(mem_dc, null_pen);
        let dot_x = pad + ctx.scale(10);
        let dot_y = cur_y + ctx.scale(13);
        let dot_size = ctx.scale(8);
        RoundRect(
            mem_dc,
            dot_x,
            dot_y,
            dot_x + dot_size,
            dot_y + dot_size,
            dot_size,
            dot_size,
        );
        SelectObject(mem_dc, old_b);
        SelectObject(mem_dc, old_p);
        DeleteObject(dot_brush as *mut _);

        // Adapter Name
        SelectObject(mem_dc, ctx.font_bold as *mut _);
        SetTextColor(mem_dc, rgb(240, 240, 250));
        let mut name_rect = RECT {
            left: pad + ctx.scale(24),
            top: cur_y + ctx.scale(6),
            right: width - ctx.scale(145),
            bottom: cur_y + ctx.scale(24),
        };
        let name_wide = to_wide(name);
        DrawTextW(
            mem_dc,
            name_wide.as_ptr(),
            -1,
            &mut name_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
        );

        // Subtitle: Local IPv4 & Type
        SelectObject(mem_dc, ctx.font_small as *mut _);
        SetTextColor(mem_dc, rgb(150, 155, 183));
        let type_tag = if state.adapter.is_wireless {
            "Wi-Fi"
        } else {
            "LAN"
        };
        let subtitle = format!("{} • {}", ip, type_tag);
        let mut ip_rect = RECT {
            left: pad + ctx.scale(24),
            top: cur_y + ctx.scale(26),
            right: width - ctx.scale(145),
            bottom: cur_y + ctx.scale(42),
        };
        let ip_wide = to_wide(&subtitle);
        DrawTextW(
            mem_dc,
            ip_wide.as_ptr(),
            -1,
            &mut ip_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
        );

        // Download speed uses the FluxFetch Wi-Fi teal accent.
        SelectObject(mem_dc, ctx.font_bold as *mut _);
        SetTextColor(mem_dc, rgb(86, 216, 189));
        let dl_str = format!("↓ {}", format_speed(dl_mbps));
        let dl_wide = to_wide(&dl_str);
        let mut dl_rect = RECT {
            left: width - ctx.scale(145),
            top: cur_y + ctx.scale(6),
            right: width - pad - ctx.scale(10),
            bottom: cur_y + ctx.scale(24),
        };
        DrawTextW(
            mem_dc,
            dl_wide.as_ptr(),
            -1,
            &mut dl_rect,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
        );

        // Upload speed uses the FluxFetch amber accent.
        SelectObject(mem_dc, ctx.font_normal as *mut _);
        SetTextColor(mem_dc, rgb(216, 164, 76));
        let ul_str = format!("↑ {}", format_speed(ul_mbps));
        let ul_wide = to_wide(&ul_str);
        let mut ul_rect = RECT {
            left: width - ctx.scale(145),
            top: cur_y + ctx.scale(26),
            right: width - pad - ctx.scale(10),
            bottom: cur_y + ctx.scale(42),
        };
        DrawTextW(
            mem_dc,
            ul_wide.as_ptr(),
            -1,
            &mut ul_rect,
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
        );

        cur_y += row_h;
    }

    // 5. Blit offscreen buffer directly to the window DC
    BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

    // 6. Cleanup GDI resources
    SelectObject(mem_dc, old_bmp);
    DeleteObject(mem_bmp as *mut _);
    DeleteDC(mem_dc);
}

fn format_speed(mbps: f64) -> String {
    if mbps >= 1000.0 {
        format!("{:.2} Gbps", mbps / 1000.0)
    } else {
        format!("{:.1} Mbps", mbps)
    }
}

#[inline]
fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}
