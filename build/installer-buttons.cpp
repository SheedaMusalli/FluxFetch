#include <windows.h>
#include <commctrl.h>

struct ButtonStyle { bool primary; bool hover; int choice; };
static LRESULT CALLBACK PaintButton(HWND window, UINT message, WPARAM w, LPARAM l,
                                  UINT_PTR id, DWORD_PTR data) {
  auto style = reinterpret_cast<ButtonStyle*>(data);
  if (message == WM_PAINT || message == WM_PRINTCLIENT) {
    PAINTSTRUCT ps{};
    HDC dc = message == WM_PAINT ? BeginPaint(window, &ps) : reinterpret_cast<HDC>(w);
    RECT rect; GetClientRect(window, &rect);
    HBRUSH backdrop = CreateSolidBrush(RGB(23,25,37));
    FillRect(dc, &rect, backdrop); DeleteObject(backdrop);
    bool enabled = IsWindowEnabled(window);
    if (style->choice) {
      int size = MulDiv(15, GetDpiForWindow(window), 96);
      int top = (rect.bottom - size) / 2;
      bool checked = SendMessage(window, BM_GETCHECK, 0, 0) == BST_CHECKED;
      HPEN border = CreatePen(PS_SOLID, 1, checked ? RGB(158,204,255) : RGB(116,120,139));
      HBRUSH fill = CreateSolidBrush(checked ? RGB(158,204,255) : RGB(49,51,64));
      auto oldPen = SelectObject(dc, border); auto oldBrush = SelectObject(dc, fill);
      if (style->choice == 2) Ellipse(dc, 0, top, size, top + size);
      else RoundRect(dc, 0, top, size, top + size, 4, 4);
      SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(border); DeleteObject(fill);
      if (checked) {
        HPEN tick = CreatePen(PS_SOLID, 2, RGB(35,48,65));
        oldPen = SelectObject(dc, tick);
        MoveToEx(dc, size/5, top + size/2, nullptr);
        LineTo(dc, size*2/5, top + size*3/4); LineTo(dc, size*4/5, top + size/4);
        SelectObject(dc, oldPen); DeleteObject(tick);
      }
      RECT label = rect; label.left = size + MulDiv(9, GetDpiForWindow(window), 96);
      SetBkMode(dc, TRANSPARENT); SetTextColor(dc, enabled ? RGB(240,240,250) : RGB(112,116,140));
      auto font = SelectObject(dc, reinterpret_cast<HFONT>(SendMessage(window, WM_GETFONT, 0, 0)));
      wchar_t text[256]; GetWindowTextW(window, text, 256);
      DrawTextW(dc, text, -1, &label, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
      SelectObject(dc, font);
      if (GetFocus() == window && !(SendMessage(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) DrawFocusRect(dc, &label);
      if (message == WM_PAINT) EndPaint(window, &ps);
      return 0;
    }
    bool down = (SendMessage(window, BM_GETSTATE, 0, 0) & BST_PUSHED) != 0;
    COLORREF fill = style->primary ? RGB(169,154,255) : RGB(37,39,55);
    if (style->hover && enabled) fill = style->primary ? RGB(189,177,255) : RGB(52,54,74);
    if (down && enabled) fill = style->primary ? RGB(145,125,234) : RGB(29,31,45);
    if (!enabled) fill = RGB(32,34,47);
    HPEN pen = CreatePen(PS_SOLID, 1, style->primary ? fill : RGB(69,72,96));
    HBRUSH brush = CreateSolidBrush(fill);
    auto oldPen = SelectObject(dc, pen); auto oldBrush = SelectObject(dc, brush);
    int radius = MulDiv(22, GetDpiForWindow(window), 96);
    RoundRect(dc, 0, 0, rect.right, rect.bottom, radius, radius);
    SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen); DeleteObject(brush);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, !enabled ? RGB(112,116,140) : style->primary ? RGB(23,25,37) : RGB(240,240,250));
    auto font = SelectObject(dc, reinterpret_cast<HFONT>(SendMessage(window, WM_GETFONT, 0, 0)));
    wchar_t text[256]; GetWindowTextW(window, text, 256);
    DrawTextW(dc, text, -1, &rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, font);
    if (GetFocus() == window && !(SendMessage(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) {
      InflateRect(&rect, -4, -4); DrawFocusRect(dc, &rect);
    }
    if (message == WM_PAINT) EndPaint(window, &ps);
    return 0;
  }
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_MOUSEMOVE && !style->hover) {
    style->hover = true;
    TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, window, 0}; TrackMouseEvent(&track);
    InvalidateRect(window, nullptr, FALSE);
  }
  if (message == WM_MOUSELEAVE) { style->hover = false; InvalidateRect(window, nullptr, FALSE); }
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(window, PaintButton, id); delete style;
    return DefSubclassProc(window, message, w, l);
  }
  auto result = DefSubclassProc(window, message, w, l);
  if (message == WM_ENABLE || message == WM_SETFOCUS || message == WM_KILLFOCUS ||
      message == BM_SETSTATE || message == BM_SETCHECK || message == WM_SETTEXT || message == WM_UPDATEUISTATE)
    InvalidateRect(window, nullptr, FALSE);
  return result;
}
extern "C" void __stdcall StyleButton(HWND window, int primary) {
  DWORD_PTR existing = 0;
  if (!window || GetWindowSubclass(window, PaintButton, 1, &existing)) return;
  auto style = new ButtonStyle{primary != 0, false, 0};
  if (!SetWindowSubclass(window, PaintButton, 1, reinterpret_cast<DWORD_PTR>(style))) delete style;
  InvalidateRect(window, nullptr, TRUE);
}
extern "C" void __stdcall StyleChoice(HWND window, int radio) {
  DWORD_PTR existing = 0;
  if (!window || GetWindowSubclass(window, PaintButton, 1, &existing)) return;
  auto style = new ButtonStyle{false, false, radio ? 2 : 1};
  if (!SetWindowSubclass(window, PaintButton, 1, reinterpret_cast<DWORD_PTR>(style))) delete style;
  InvalidateRect(window, nullptr, TRUE);
}
