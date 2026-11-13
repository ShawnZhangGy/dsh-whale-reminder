/**
 * Loopback-only self-test route.
 *
 * Acceptance for this plugin is "the taskbar actually blinks", which cannot be
 * asserted from inside the Host. This route lets an external script ask the Host
 * to flash now and report which window it would flash, so a screenshot-diff
 * check has a deterministic trigger instead of waiting for a real turn to end.
 *
 * The fence is the same one the shipped plugins use: the TCP peer must be a
 * loopback address, the `Host` header must name a loopback authority (which
 * defeats DNS-rebinding), the request must not be a cross-site fetch, and a
 * present `Origin` must be same-origin. Without all of that the route answers
 * 403 and the Host stays untouched — an unfenced trigger reachable from a web
 * page would let any site make the application flash.
 *
 * @module dsh-whale-reminder/selftest-route
 */

/** Path that triggers a flash. */
export const TEST_FLASH_PATH = '/__whale-reminder/self-test'

/** Path that reports state without changing it. */
export const TEST_STATE_PATH = '/__whale-reminder/state'

/** Path the Client half posts its attention-dot counts to. */
export const DOTS_PATH = '/__whale-reminder/dots'

/** Refuse a body larger than this; a dot report is a handful of integers. */
const MAX_BODY_BYTES = 4096

/**
 * Whether an address literal is loopback.
 *
 * @param address - `socket.remoteAddress`.
 * @returns true for 127.0.0.0/8 and ::1.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (normalized === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/**
 * Whether a hostname text names this machine.
 *
 * @param hostname - hostname from a URL.
 * @returns true for localhost and loopback literals.
 */
export function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || isLoopbackAddress(hostname)
}

/**
 * Reject requests that did not come from a local same-origin caller.
 *
 * @param request - incoming Host request.
 * @returns true when the request may drive the plugin.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  if (hasForwardingHeader(request?.headers)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request?.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request?.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Whether the request carries any proxy forwarding header.
 *
 * @param headers - request headers.
 * @returns true when at least one is present.
 */
function hasForwardingHeader(headers) {
  if (headers === undefined || headers === null) return false
  return headers['x-forwarded-for'] !== undefined
    || headers['x-forwarded-host'] !== undefined
    || headers['x-real-ip'] !== undefined
    || headers.forwarded !== undefined
}

/**
 * Read and parse a small JSON request body.
 *
 * @param request - incoming request.
 * @param done - called with `(parsed)` or `(undefined, error)` exactly once.
 */
function readJson(request, done) {
  const chunks = []
  let size = 0
  let settled = false

  const finish = (value, error) => {
    if (settled) return
    settled = true
    done(value, error)
  }

  request.on('data', (chunk) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      finish(undefined, 'body too large')
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    if (settled) return
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') {
      finish({}, undefined)
      return
    }
    try {
      finish(JSON.parse(text), undefined)
    } catch {
      finish(undefined, 'body is not valid JSON')
    }
  })
  request.on('error', () => finish(undefined, 'request stream failed'))
}

/**
 * Write a JSON response with the headers a diagnostic endpoint owes its caller.
 *
 * @param response - Host response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
export function writeJson(response, status, body) {
  const text = `${JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Build the diagnostic routes.
 *
 * @param dependencies - the controller, window port, options and logger.
 * @returns route descriptors for `webServer.register`.
 */
export function createSelfTestRoutes(dependencies) {
  const { attention, options, logger, toast } = dependencies

  const flash = (request, response) => {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'POST required' })
      return
    }
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    const result = attention.selfTest?.() ?? attention.notify({ kind: 'self-test' })
    // The settings test button is the one place a person can check that the
    // whole chain works, so the toast is raised alongside the flash. It is
    // reported separately: a platform without WinRT still demonstrates the
    // flash, and a toast failure must not make the button look broken.
    //
    // The toast carries the current session's launch URI on purpose. A test
    // notification that cannot be clicked proves only half the chain, and
    // "click it and see" is exactly the check this button exists for.
    const launch = dependencies.launchUri?.(dependencies.currentSessionId?.())
    let notified
    try {
      notified = toast?.show?.({
        headline: options.language === 'en' ? 'Test reminder' : '测试提醒',
        detail: options.language === 'en'
          ? 'Taskbar, tray, sound and this notification all work. Click it to jump back here.'
          : '任务栏、托盘、声音和这条通知都正常。点它可跳回当前会话。',
        silent: options.systemNotifySound !== true,
        launch,
      })
    } catch (error) {
      logger?.warn?.(`whale-reminder: self-test toast failed: ${error?.message ?? error}`)
      notified = { sent: false, reason: 'threw' }
    }
    const focused = result.hwnd === undefined ? undefined : dependencies.port.isForeground(result.hwnd)
    logger?.info?.(`whale-reminder: self-test -> ${JSON.stringify({ ...result, hwnd: String(result.hwnd ?? ''), notified })}`)
    writeJson(response, 200, {
      ok: result.started || result.reason === 'already-flashing',
      started: result.started,
      reason: result.reason,
      hwnd: result.hwnd === undefined ? undefined : `0x${BigInt(result.hwnd).toString(16)}`,
      foreground: focused,
      notified,
      options: {
        flashCaption: options.flashCaption,
        flashCount: options.flashCount,
        flashTimeout: options.flashTimeout,
        maxFlashSeconds: options.maxFlashSeconds,
        systemNotify: options.systemNotify,
        systemNotifySound: options.systemNotifySound,
        systemNotifyOnlyWhenUnfocused: options.systemNotifyOnlyWhenUnfocused,
        clickAction: options.clickAction,
      },
      state: attention.snapshot(),
    })
  }

  const state = (request, response) => {
    if (request.method !== 'POST' && request.method !== 'GET') {
      writeJson(response, 405, { ok: false, error: 'GET or POST required' })
      return
    }
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    const stopped = request.method === 'POST' ? attention.stop('self-test') : undefined
    // The activate ring buffer is the only record of a click that reached the
    // Host, so it belongs on the diagnostic snapshot: without it a dropped
    // navigation is indistinguishable from a toast that never fired.
    const activate = dependencies.activateDiagnostics?.()
    writeJson(response, 200, { ok: true, stopped, state: attention.snapshot(), activate })
  }

  const dots = (request, response) => {
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      writeJson(response, 405, { ok: false, error: 'POST or DELETE required' })
      return
    }
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    if (request.method === 'DELETE') {
      attention.clearDots()
      writeJson(response, 200, { ok: true, cleared: true, dots: attention.snapshot().dots })
      return
    }
    readJson(request, (parsed, error) => {
      if (error !== undefined) {
        writeJson(response, 400, { ok: false, error })
        return
      }
      const reported = attention.updateDots(parsed)
      writeJson(response, 200, { ok: true, dots: reported })
    })
  }

  return [
    { kind: 'exact', path: TEST_FLASH_PATH, handler: flash },
    { kind: 'exact', path: TEST_STATE_PATH, handler: state },
    { kind: 'exact', path: DOTS_PATH, handler: dots },
  ]
}
