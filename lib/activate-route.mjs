/**
 * Click-through from a Windows toast back into the right session.
 *
 * A toast is only useful if it is a door. Windows resolves the `launch` URI of a
 * `activationType="protocol"` toast through the registry, so this module
 * registers a private protocol (`dsh-whale-reminder:`) whose handler is a tiny
 * native executable shipped in `assets/activate.exe`.
 *
 * The handler deliberately writes no files. An earlier WScript version tried to
 * hand the session id over through `%LOCALAPPDATA%`, but the process Windows
 * starts for a toast click cannot always write there, so the hand-off silently
 * failed. The handler now reports the click straight back to the running
 * application over the loopback web server instead: the port is baked into the
 * registry command, and the id travels as a query parameter.
 *
 * The Client half polls `ACTIVATE_PATH` while the window is in the background —
 * exactly when a toast is worth clicking — and turns the id into navigation.
 *
 * Registry writes go through `reg.exe` because plain Node has no registry API.
 * They live under HKCU, so no elevation is involved, and re-registering on every
 * start is idempotent and repairs a key that something else removed.
 *
 * @module dsh-whale-reminder/activate-route
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Protocol scheme this plugin owns. */
export const ACTIVATE_PROTOCOL = 'dsh-whale-reminder'

/** Path the protocol handler calls and the Client half polls. */
export const ACTIVATE_PATH = '/__whale-reminder/activate'

/** Session ids are opaque, but never empty and never path-shaped. */
const SESSION_ID = /^[\w.:-]{1,200}$/

/**
 * The click the handler has reported but the Client has not collected yet.
 *
 * Not a single-consumer slot: the application can have more than one Client
 * half alive at a time (the welcome window and the main window are separate
 * WebContents), and whichever polled first used to swallow the click. If that
 * happened to be the window the person was not looking at, the navigation ran
 * in the wrong place and the visible window appeared to ignore the click.
 *
 * So the click is broadcast: it stays readable for `PENDING_TTL_MS`, carries a
 * monotonic `seq`, and every Client half decides for itself whether it is the
 * one that should act. Reading no longer consumes.
 */
let pending

/** Monotonic click counter, so a Client can tell "new click" from "same one". */
let sequence = 0

/** How long a reported click stays readable. */
const PENDING_TTL_MS = 15_000

/**
 * Recent activate-route traffic, oldest first.
 *
 * A click that fails to navigate leaves nothing behind: the handler exits, the
 * slot empties, and the Client swallows its own errors. This ring buffer is the
 * only place that remembers "the handler reported X at T", which is what
 * separates a broken toast from a navigation the Workspace refused.
 */
const history = []

/** How many events to remember; enough for one debugging session. */
const HISTORY_LIMIT = 24

/**
 * Record one activate event.
 *
 * @param entry - `{ kind, sessionId?, detail? }`.
 */
function noteEvent(entry) {
  history.push({ at: Date.now(), ...entry })
  if (history.length > HISTORY_LIMIT) history.shift()
}

/**
 * Snapshot the pending click and the recent traffic.
 *
 * @returns `{ pending, history }`, both safe to serialize.
 */
export function activateDiagnostics() {
  return {
    pending: peekPending() ?? null,
    sequence,
    history: history.map((entry) => ({ ...entry })),
  }
}

/**
 * Directory the protocol handler lives in.
 *
 * @returns an absolute directory path.
 */
export function handlerDirectory() {
  const base = process.env.LOCALAPPDATA
  const root = typeof base === 'string' && base.length > 0 ? base : tmpdir()
  return join(root, 'dsh-whale-reminder')
}

/**
 * Record the live loopback port where the activation handler can read it.
 *
 * The port is also baked into the registry command, but that command is only
 * rewritten when the plugin starts. If the application is restarted in a way
 * that leaves an old toast around, the handler's command line still names the
 * dead port; this file is the second chance. A toast handler may run with a
 * restricted token that forbids writes to `%LOCALAPPDATA%`, so this is written
 * here (by the Host, which can write) and only read there.
 *
 * @param port - loopback port the web server is listening on.
 * @param logger - Host logger.
 * @returns the file path, or undefined on failure.
 */
export function writePortFile(port, logger) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  try {
    const directory = handlerDirectory()
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const target = join(directory, 'port.txt')
    writeFileSync(target, `${port}\n`, 'utf8')
    return target
  } catch (error) {
    logger?.warn?.(`whale-reminder: could not record the loopback port: ${error?.message ?? error}`)
    return undefined
  }
}

/**
 * Build the toast launch URI for one session.
 *
 * @param sessionId - session the toast belongs to.
 * @returns the URI string, or undefined when the id is unusable.
 */
export function launchUri(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined
  return `${ACTIVATE_PROTOCOL}://open/${sessionId}`
}

/**
 * Pull the loopback port out of a web server origin.
 *
 * @param origin - `getOrigin()` result, for example `http://127.0.0.1:3080`.
 * @returns the port as a number, or undefined when it cannot be read.
 */
export function activatePortFrom(origin) {
  if (typeof origin !== 'string') return undefined
  try {
    const url = new URL(origin)
    const port = Number.parseInt(url.port, 10)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the pending click without consuming it.
 *
 * @returns the live click, or undefined when nothing is pending or it expired.
 */
export function peekPending() {
  if (pending === undefined) return undefined
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    noteEvent({ kind: 'expired', sessionId: pending.sessionId })
    pending = undefined
    return undefined
  }
  return { sessionId: pending.sessionId, seq: pending.seq }
}

/**
 * Take and clear the pending navigation, if the person clicked a toast.
 *
 * Kept for the single-window case and for tests: the route no longer uses it,
 * because consuming on read let the wrong window steal the click.
 *
 * @returns the session id, or undefined when nothing is pending.
 */
export function takePending() {
  const live = peekPending()
  pending = undefined
  if (live !== undefined) noteEvent({ kind: 'collected', sessionId: live.sessionId })
  return live?.sessionId
}

/**
 * Record a click reported by the protocol handler.
 *
 * @param sessionId - session id parsed from the launch URI.
 * @returns whether the id was accepted.
 */
export function notePending(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    noteEvent({ kind: 'rejected', sessionId: String(sessionId), detail: 'not a session id' })
    return false
  }
  sequence += 1
  pending = { sessionId, seq: sequence, at: Date.now() }
  noteEvent({ kind: 'reported', sessionId })
  return true
}

/**
 * Copy the packaged handler next to a stable path the registry may name.
 *
 * The executable ships inside the package, but a registry entry must survive an
 * upgrade that moves or deletes the package directory, so it is copied into
 * `%LOCALAPPDATA%\\dsh-whale-reminder\\` and re-copied on every start.
 *
 * @param sourcePath - the packaged `assets/activate.exe`.
 * @param logger - Host logger.
 * @returns the installed executable path, or undefined on failure.
 */
export function installHandlerScript(sourcePath, logger) {
  try {
    const directory = handlerDirectory()
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const target = join(directory, 'activate.exe')
    copyFileSync(sourcePath, target)
    return target
  } catch (error) {
    logger?.warn?.(`whale-reminder: could not install activation handler: ${error?.message ?? error}`)
    return undefined
  }
}

/**
 * Register the protocol handler for the current user.
 *
 * The port is part of the command line because the handler must know where to
 * report the click; it changes between launches, so the key is rewritten on
 * every start.
 *
 * @param dependencies - handler path, loopback port and logger.
 * @returns whether the handler is registered.
 */
export function registerProtocolHandler(dependencies) {
  const { handlerPath, port, logger, platform = process.platform } = dependencies
  if (platform !== 'win32') return false
  if (typeof handlerPath !== 'string' || !existsSync(handlerPath)) {
    logger?.warn?.('whale-reminder: activation handler missing; toast clicks will not navigate')
    return false
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logger?.warn?.('whale-reminder: no loopback port; toast clicks will not navigate')
    return false
  }

  const base = `HKCU\\Software\\Classes\\${ACTIVATE_PROTOCOL}`
  const command = `"${handlerPath}" "%1" ${port}`
  const steps = [
    [base, '/ve', '/d', 'URL:Whale Reminder', '/f'],
    [base, '/v', 'URL Protocol', '/d', '', '/f'],
    [`${base}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
  ]

  for (const args of steps) {
    const result = spawnSync('reg.exe', ['add', ...args], { windowsHide: true, encoding: 'utf8' })
    if (result?.status !== 0) {
      logger?.warn?.(`whale-reminder: could not register ${ACTIVATE_PROTOCOL}: ${String(result?.stderr ?? '').trim().split('\n')[0]}`)
      return false
    }
  }
  return true
}

/**
 * Read the `session` query parameter out of a request URL.
 *
 * @param requestUrl - `request.url`, for example `/__whale-reminder/activate?session=abc`.
 * @returns the session id, or undefined when absent or malformed.
 */
function sessionFromUrl(requestUrl) {
  if (typeof requestUrl !== 'string') return undefined
  const index = requestUrl.indexOf('?')
  if (index < 0) return undefined
  let raw
  try {
    raw = new URLSearchParams(requestUrl.slice(index + 1)).get('session')
  } catch {
    return undefined
  }
  return typeof raw === 'string' && SESSION_ID.test(raw) ? raw : undefined
}

/**
 * Build the loopback route the handler calls and the Client half polls.
 *
 * Two verbs, both fenced by the same loopback/same-origin check the rest of the
 * plugin uses:
 *
 * - `POST ?session=<id>` — the protocol handler reporting a click. The reply
 *   carries `clickAction`, which is how the handler learns what the person
 *   allowed a click to do to the window: `raise` (forward plus keyboard),
 *   `show` (forward only) or `none` (leave the window alone).
 * - `GET` — the Client half reading the broadcast click.
 *
 * @param dependencies - fence helper, focus policy reader, logger.
 * @returns `[{ kind, path, handler }]`.
 */
export function createActivateRoutes(dependencies) {
  const { isLoopbackRequest, logger } = dependencies
  // Read per request rather than captured once: the setting is live, and a
  // click should honour the value in force at that moment. An unknown value
  // falls back to the default rather than to "do nothing", so a stale handler
  // can never make a click silently inert.
  const CLICK_ACTIONS = new Set(['raise', 'show', 'none'])
  const clickAction = () => {
    let value
    try {
      value = dependencies.clickAction?.()
    } catch {
      return 'raise'
    }
    return CLICK_ACTIONS.has(value) ? value : 'raise'
  }

  const handler = (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"ok":false,"error":"GET or POST required"}\n')
      return
    }
    if (!isLoopbackRequest(request)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"ok":false,"error":"loopback same-origin requests only"}\n')
      return
    }

    let payload
    if (request.method === 'POST') {
      const reported = sessionFromUrl(request.url)
      if (reported === undefined) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"ok":false,"error":"session required"}\n')
        return
      }
      notePending(reported)
      logger?.debug?.(`whale-reminder: toast click reported for ${reported}`)
      payload = { ok: true, sessionId: reported, seq: sequence, clickAction: clickAction() }
    } else {
      // Broadcast, not consume: every Client half sees the click and the ones
      // that are not the foreground window ignore it. Consuming here was the
      // bug — whichever window polled first stole the navigation.
      const live = peekPending()
      payload = live === undefined
        ? { ok: true, sessionId: null, seq: sequence }
        : { ok: true, sessionId: live.sessionId, seq: live.seq }
    }

    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(`${JSON.stringify(payload)}\n`)
  }

  return [{ kind: 'exact', path: ACTIVATE_PATH, handler }]
}
