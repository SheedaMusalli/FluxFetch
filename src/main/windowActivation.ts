import { app, BrowserWindow } from 'electron'

interface PendingActivation {
  timer: NodeJS.Timeout
  onFocus: () => void
}

const pendingActivations = new WeakMap<BrowserWindow, PendingActivation>()
const WINDOWS_FOREGROUND_GRACE_MS = 1600

/** Bring a window forward for a user-initiated external action (browser or clipboard). Windows
 * can reject foreground activation when another process owns focus, so briefly raise the window
 * in the topmost band while asking Electron to activate it; then restore its normal z-order. */
export function presentWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return

  const previous = pendingActivations.get(window)
  if (previous) {
    clearTimeout(previous.timer)
    window.removeListener('focus', previous.onFocus)
    previous.onFocus()
  }

  const raisedTemporarily = process.platform === 'win32' && !window.isAlwaysOnTop()
  if (raisedTemporarily) window.setAlwaysOnTop(true, 'floating')

  const restore = (): void => {
    const pending = pendingActivations.get(window)
    if (!pending || pending.onFocus !== restore) return
    clearTimeout(pending.timer)
    window.removeListener('focus', restore)
    pendingActivations.delete(window)
    if (!window.isDestroyed()) {
      window.flashFrame(false)
      if (raisedTemporarily) window.setAlwaysOnTop(false)
    }
  }

  if (process.platform === 'win32') {
    const timer = setTimeout(restore, WINDOWS_FOREGROUND_GRACE_MS)
    timer.unref()
    pendingActivations.set(window, { timer, onFocus: restore })
    window.once('focus', restore)
  }

  if (window.isMinimized()) window.restore()
  window.show()
  if (process.platform === 'win32') {
    app.focus()
    if (!window.isFocused()) window.flashFrame(true)
  }
  window.focus()

  if (process.platform === 'win32' && window.isFocused()) restore()
}
