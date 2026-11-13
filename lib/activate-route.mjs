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
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
 * One slot, not a queue: a person clicking three toasts in a row wants the last
 * door they opened, and a stale id is worse than a missed one.
 */
let pending

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
 * Take and clear the pending navigation, if the person clicked a toast.
 *
 * Reading consumes the click: the Client navigates once per click.
 *
 * @returns the session id, or undefined when nothing is pending.
 */
export function takePending() {
  const id = pending
  pending = undefined
  return id
}

/**
 * Record a click reported by the protocol handler.
 *
 * @param sessionId - session id parsed from the launch URI.
 * @returns whether the id was accepted.
 */
export function notePending(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false
  pending = sessionId
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
 * - `POST ?session=<id>` — the protocol handler reporting a click.
 * - `GET` — the Client collecting (and consuming) it.
 *
 * @param dependencies - fence helper, logger.
 * @returns `[{ kind, path, handler }]`.
 */
export function createActivateRoutes(dependencies) {
  const { isLoopbackRequest, logger } = dependencies

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

    let sessionId
    if (request.method === 'POST') {
      const reported = sessionFromUrl(request.url)
      if (reported === undefined) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"ok":false,"error":"session required"}\n')
        return
      }
      notePending(reported)
      sessionId = reported
      logger?.debug?.(`whale-reminder: toast click reported for ${reported}`)
    } else {
      sessionId = takePending()
    }

    const body = sessionId === undefined
      ? '{"ok":true,"sessionId":null}\n'
      : `{"ok":true,"sessionId":${JSON.stringify(sessionId)}}\n`
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  return [{ kind: 'exact', path: ACTIVATE_PATH, handler }]
}
