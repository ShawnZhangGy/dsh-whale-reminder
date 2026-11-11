/**
 * Tray-icon reminder for the Windows notification area.
 *
 * Electron offers no way to animate a `Tray` from outside the application, but
 * the shell's notification area is addressable directly: the application's tray
 * icon is an ordinary `NOTIFYICONIDENTIFIER` (the Electron main process's
 * `Electron_NotifyIconHostWindow` plus a small id), and `Shell_NotifyIconW` with
 * `NIM_MODIFY` replaces its image in place. That is what makes the "QQ blink"
 * possible.
 *
 * This plugin goes one step further than a plain blink: while a reminder is
 * active it alternates the shipped whale icon with a badge variant that carries
 * a red unread-count numeral, and it rewrites the hover tooltip (`szTip`) to a
 * one-line summary of what is waiting. The "off" half of the blink is the
 * ordinary icon; the "on" half is the numbered badge, which is how QQ/WeChat
 * show an unread count in the tray.
 *
 * Everything is optional: when the tray host window or an icon file cannot be
 * found, {@link createTrayBlink} reports `available: false` and the caller keeps
 * flashing the taskbar button alone.
 *
 * @module dsh-whale-reminder/tray
 */

/** `Shell_NotifyIconW` message: change an existing icon in place. */
const NIM_MODIFY = 1

/** `NOTIFYICONDATAW.uFlags` bit: the `hIcon` member is meaningful. */
const NIF_ICON = 0x2

/** `NOTIFYICONDATAW.uFlags` bit: the `szTip` member is meaningful. */
const NIF_TIP = 0x4

/** `LoadImageW` type: an icon resource. */
const IMAGE_ICON = 1

/** `LoadImageW` flag: read the image from the file `name` points at. */
const LR_LOADFROMFILE = 0x10

/** Class name of the hidden window Electron uses to own tray icons. */
const TRAY_HOST_CLASS = 'Electron_NotifyIconHostWindow'

/**
 * Size of `NOTIFYICONDATAW` on x64 for this Windows version.
 *
 * The struct grew over releases; 976 is what this build accepts, and a wrong
 * `cbSize` makes every call fail with `ERROR_INVALID_PARAMETER` and no diagnosis.
 */
const NOTIFYICONDATAW_SIZE = 976

/** Size of `NOTIFYICONIDENTIFIER`, also versioned: 40 is the current layout. */
const NOTIFYICONIDENTIFIER_SIZE = 40

/** Highest icon id probed on the host window. */
const MAX_PROBED_UID = 16

/**
 * `NOTIFYICONDATAW` member offsets on x64.
 *
 * The struct grew over releases; these are the offsets for the 976-byte layout:
 * cbSize DWORD@0, hWnd HWND@8, uID UINT@16, uFlags UINT@20, uCallbackMessage
 * UINT@24, hIcon HICON@32, szTip WCHAR[128]@40.
 */
const OFF_HWND = 8
const OFF_UID = 16
const OFF_FLAGS = 20
const OFF_HICON = 32
const OFF_SZTIP = 40
const SZTIP_BYTES = 256 // 128 UTF-16 code units
const SZTIP_MAX_CHARS = 127 // leave one code unit for the NUL terminator

/**
 * Locate the tray icon owned by one process.
 *
 * The id is not exposed anywhere, so it is discovered by asking the shell for the
 * screen rectangle of every candidate id: an id that answers with a rectangle is
 * in use, and one that returns `E_INVALIDARG` is not.
 *
 * @param trayHost - bound Win32 surface (see `createTrayPort`).
 * @returns `{ hwnd, uid }`, or `undefined` when this process owns no tray icon.
 */
export function findTrayIcon(trayHost) {
  for (const hwnd of trayHost.trayHostWindows()) {
    for (let uid = 0; uid <= MAX_PROBED_UID; uid += 1) {
      if (trayHost.rectOf(hwnd, uid) !== undefined) return { hwnd, uid }
    }
  }
  return undefined
}

/**
 * Bind the extra user32/shell32 entry points the tray needs.
 *
 * @param koffi - the loaded koffi module.
 * @param user32 - the already-loaded `user32.dll` surface.
 * @param shell32 - the loaded `shell32.dll` surface.
 * @param helpers - window enumeration and process id helpers from `win32.mjs`.
 * @returns the tray-specific surface.
 */
export function createTrayPort(koffi, user32, shell32, helpers) {
  const loadImageW = user32.func('void* __stdcall LoadImageW(void* inst, void* name, uint32 type, int cx, int cy, uint32 flags)')
  const destroyIcon = user32.func('bool __stdcall DestroyIcon(void* icon)')
  const shellNotifyIconW = shell32.func('bool __stdcall Shell_NotifyIconW(uint32 msg, void* data)')
  const shellNotifyIconGetRect = shell32.func('long __stdcall Shell_NotifyIconGetRect(void* id, void* rect)')

  /**
   * Enumerate the tray host windows owned by any of the given processes.
   *
   * @param pids - candidate process ids.
   * @returns the matching window handles, as bigints.
   */
  function trayHostWindows(pids) {
    return helpers
      .listWindowsFor(pids)
      .filter((window) => window.className === TRAY_HOST_CLASS)
      .map((window) => window.hwnd)
  }

  /**
   * Ask the shell where one tray icon is drawn.
   *
   * @param hwnd - tray host window.
   * @param uid - icon id on that window.
   * @returns the rectangle, or `undefined` when no icon has that id.
   */
  function rectOf(hwnd, uid) {
    const identifier = Buffer.alloc(NOTIFYICONIDENTIFIER_SIZE)
    identifier.writeUInt32LE(NOTIFYICONIDENTIFIER_SIZE, 0)
    identifier.writeBigUInt64LE(BigInt(hwnd), 8)
    identifier.writeUInt32LE(uid, 16)
    const rect = Buffer.alloc(16)
    if (shellNotifyIconGetRect(identifier, rect) !== 0) return undefined
    return {
      left: rect.readInt32LE(0),
      top: rect.readInt32LE(4),
      right: rect.readInt32LE(8),
      bottom: rect.readInt32LE(12),
    }
  }

  /**
   * Load one icon file.
   *
   * @param path - absolute `.ico` path.
   * @returns the icon handle, or `undefined` when the file cannot be loaded.
   */
  function loadIcon(path) {
    const name = Buffer.from(`${path}\0`, 'utf16le')
    const handle = loadImageW(null, name, IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
    return handle === null || handle === undefined ? undefined : handle
  }

  /**
   * Replace the image and tooltip of one tray icon.
   *
   * @param hwnd - tray host window.
   * @param uid - icon id.
   * @param icon - icon handle from {@link loadIcon}.
   * @param tip - optional tooltip text; omit to leave the tooltip untouched.
   * @returns true when the shell accepted the change.
   */
  function setIcon(hwnd, uid, icon, tip) {
    const data = Buffer.alloc(NOTIFYICONDATAW_SIZE)
    data.writeUInt32LE(NOTIFYICONDATAW_SIZE, 0)
    data.writeBigUInt64LE(BigInt(hwnd), OFF_HWND)
    data.writeUInt32LE(uid, OFF_UID)
    let flags = NIF_ICON
    if (tip !== undefined) {
      flags |= NIF_TIP
      const text = String(tip).slice(0, SZTIP_MAX_CHARS)
      const tipBuf = Buffer.from(`${text}\0`, 'utf16le')
      tipBuf.copy(data, OFF_SZTIP, 0, Math.min(tipBuf.length, SZTIP_BYTES))
    }
    data.writeUInt32LE(flags, OFF_FLAGS)
    data.writeBigUInt64LE(BigInt(icon), OFF_HICON)
    return Boolean(shellNotifyIconW(NIM_MODIFY, data))
  }

  /**
   * Release an icon handle.
   *
   * @param icon - handle from {@link loadIcon}.
   */
  function releaseIcon(icon) {
    if (icon !== undefined) destroyIcon(icon)
  }

  return { trayHostWindows, rectOf, loadIcon, setIcon, releaseIcon }
}

/**
 * Build the badge-blinking tray controller.
 *
 * While active it alternates the ordinary whale icon with a numbered badge, and
 * rewrites the hover tooltip to a one-line summary. The badge and the tooltip
 * are re-derived from {@link getCount} on every step, so a growing unread count
 * updates the numeral in place.
 *
 * @param dependencies - tray port, icon paths, pids, badge/tooltip selectors.
 * @returns the controller.
 */
export function createTrayBlink(dependencies) {
  const {
    port,
    originalIconPath,
    badgeIconFor,
    tooltipFor,
    getCount = () => 0,
    pids,
    intervalMs = 600,
    logger,
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (handle) => clearInterval(handle),
  } = dependencies

  /** Resolved tray identity, looked up once and reused. */
  let target
  /** The application's own icon, kept alive while it may be displayed. */
  let normalIcon
  /** Loaded badge handles, keyed by their file path. */
  const badgeIcons = new Map()
  let timer
  let showingBadge = false
  /** Set once a lookup has definitively failed, so the log stays quiet. */
  let unavailable

  /**
   * Resolve the tray icon, loading the ordinary image the first time needed.
   *
   * @returns the identity, or `undefined`.
   */
  function prepare() {
    if (target !== undefined && normalIcon !== undefined) return target
    target = findTrayIcon({ trayHostWindows: () => port.trayHostWindows(pids), rectOf: port.rectOf })
    if (target === undefined) return undefined
    const normal = port.loadIcon(originalIconPath)
    if (normal === undefined) return undefined
    normalIcon = normal
    logger?.info?.(`whale-reminder: tray icon found on window ${handleText(target.hwnd)} (id ${String(target.uid)})`)
    return target
  }

  /**
   * Load (or reuse) the badge icon for one path.
   *
   * @param path - absolute `.ico` path.
   * @returns the icon handle, or `undefined`.
   */
  function badgeIcon(path) {
    if (path === undefined) return undefined
    let handle = badgeIcons.get(path)
    if (handle !== undefined) return handle
    handle = port.loadIcon(path)
    if (handle === undefined) return undefined
    badgeIcons.set(path, handle)
    return handle
  }

  /**
   * Show either the badge or the ordinary icon, with a matching tooltip.
   *
   * @param badge - true to show the numbered badge.
   * @returns true when the shell accepted it.
   */
  function show(badge) {
    if (target === undefined || normalIcon === undefined) return false
    const count = getCount()
    if (badge) {
      const path = badgeIconFor?.(count)
      const icon = badgeIcon(path)
      if (icon === undefined) return false
      const tip = tooltipFor?.(count)
      const ok = port.setIcon(target.hwnd, target.uid, icon, tip)
      if (ok) showingBadge = true
      return ok
    }
    const ok = port.setIcon(target.hwnd, target.uid, normalIcon, tooltipFor?.(count))
    if (ok) showingBadge = false
    return ok
  }

  /** Perform one blink step: flip to the other image. */
  function tick() {
    show(!showingBadge)
  }

  /**
   * Start blinking. Safe to call while already blinking.
   *
   * @returns true when blinking actually started.
   */
  function start() {
    if (timer !== undefined) return true
    if (unavailable !== undefined) return false
    if (prepare() === undefined) {
      unavailable = true
      logger?.warn?.('whale-reminder: no tray icon found for this process; taskbar flashing only')
      return false
    }
    if (!show(true)) {
      unavailable = true
      logger?.warn?.('whale-reminder: the shell refused the tray icon change; taskbar flashing only')
      return false
    }
    timer = setIntervalFn(tick, Math.max(200, Math.trunc(intervalMs)))
    if (typeof timer?.unref === 'function') timer.unref()
    return true
  }

  /**
   * Stop blinking and put the application's own icon back.
   *
   * @returns true when the original image was restored.
   */
  function stop() {
    if (timer !== undefined) {
      clearIntervalFn(timer)
      timer = undefined
    }
    if (target === undefined || normalIcon === undefined) return false
    return show(false)
  }

  /**
   * Release everything: stop blinking, restore the image, destroy the handles.
   */
  function dispose() {
    stop()
    if (normalIcon !== undefined) {
      port.releaseIcon(normalIcon)
      normalIcon = undefined
    }
    for (const icon of badgeIcons.values()) port.releaseIcon(icon)
    badgeIcons.clear()
    target = undefined
  }

  return {
    start,
    stop,
    dispose,
    tick,
    snapshot() {
      return {
        available: unavailable === undefined && target !== undefined,
        blinking: timer !== undefined,
        showingBadge,
        target: target === undefined
          ? undefined
          : { hwnd: handleText(target.hwnd), uid: target.uid },
      }
    },
  }
}

/**
 * Render a window handle for a log line.
 *
 * @param hwnd - handle as bigint or number.
 * @returns hexadecimal text.
 */
function handleText(hwnd) {
  try {
    return `0x${BigInt(hwnd).toString(16)}`
  } catch {
    return String(hwnd)
  }
}
