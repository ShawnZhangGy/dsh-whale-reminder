/**
 * Host half of `dsh-whale-reminder`.
 *
 * Watches the Session log for the moments a person needs to be called back —
 * a turn that produced an answer nobody has looked at, a tool blocked on a human
 * decision, or a turn that ended in an error — and asks Windows to flash the
 * Harness taskbar button, blink the tray icon with a red unread-count badge, and
 * hand the Client half the counts it needs to play a sound and show a floating
 * summary.
 *
 * Why the Session log and nothing else:
 *
 * - `turn/end` is committed once per finished turn, for every Session, and is
 *   the same event the Client uses to decide its unread dot.
 * - `approval/asked` is a log-only audit event appended inside an open turn. It
 *   plays no part in the approval decision, so observing it cannot influence
 *   policy.
 * - A pending question is visible as the `tool/call` for `ask_user_question`.
 *   Reading that event keeps this plugin out of the `user-questions/request`
 *   waterfall entirely — it never answers, never delegates, and therefore cannot
 *   swallow a prompt.
 *
 * @module dsh-whale-reminder
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAttention } from './attention.mjs'
import { createDots } from './dots.mjs'
import { loadKoffi } from './koffi-loader.mjs'
import { loadSchemastery } from './schemastery-loader.mjs'
import { createSelfTestRoutes } from './selftest-route.mjs'
import { createTrayBlink, createTrayPort } from './tray.mjs'
import { createWin32 } from './win32.mjs'

/**
 * Schema constructor, loaded through `schemastery-loader.mjs` because a
 * `link:`/`file:`-installed plugin has no own `node_modules` to satisfy a static
 * `import '@deepseek-ai/schemastery'` from (verified ERR_MODULE_NOT_FOUND).
 */
const z = loadSchemastery()

/** Package root, so the bundled badge icons resolve regardless of install mode. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Where the application's own tray icon lives, relative to its resources folder.
 *
 * `process.resourcesPath` already IS the resources directory, so this must not
 * repeat the segment.
 */
const ORIGINAL_ICON = 'tray.ico'

/** Stable Cordis plugin name; must match the package name. */
export const name = 'dsh-whale-reminder'

/**
 * No required service: attention comes from the Session event bus, which every
 * Host context carries. The settings service and the Web server are mounted on
 * demand below through `ctx.inject`, so a Host without them simply gets no
 * configuration form or self-test route.
 */
export const inject = []

/** Log prefix for every line this plugin writes. */
const LOG = 'whale-reminder:'

/** Tool whose call means the model is waiting for a human answer. */
const QUESTION_TOOL = 'ask_user_question'

/**
 * Configuration schema.
 *
 * Every field is `volatile` so the Client half writes it in place through
 * `configForms` and the Host reads the live value through `.get()`; none of it
 * is persisted through the default settings boundary because this plugin ships
 * no separate settings page — the plugin-manager's row config page owns it.
 */
export const Config = z.object({
  // Master switch.
  enabled: z.boolean().default(true).volatile(),

  // Which event kinds raise attention, in either half.
  triggerComplete: z.boolean().default(true).volatile(),
  triggerPending: z.boolean().default(true).volatile(),
  triggerError: z.boolean().default(true).volatile(),

  // Wording of this plugin's own surfaces (Client half only).
  language: z.union(['zh', 'en']).default('zh').volatile(),

  // Sound (Client half only). The two cues are fixed in code; only the
  // volume is adjustable, so there are no path fields here.
  soundVolume: z.number().step(1).min(0).max(100).default(60).volatile(),

  // Attention conditions (Client half only; the Host's focus rules are fixed).
  triggerWindowHidden: z.boolean().default(true).volatile(),
  triggerWindowBlurred: z.boolean().default(true).volatile(),
  triggerOtherSession: z.boolean().default(true).volatile(),

  // Floating summary (Client half only).
  overlayCount: z.number().step(1).min(1).max(20).default(3).volatile(),
  tooltipLength: z.number().step(1).min(1).max(256).default(127).volatile(),
  overlayCorner: z.union(['bottomRight', 'bottomLeft', 'topRight', 'topLeft']).default('bottomRight').volatile(),

  // Taskbar/tray flashing (Host half).
  flashCaption: z.boolean().default(true).volatile(),
  onlyWhenUnfocused: z.boolean().default(true).volatile(),
  flashUntilMouseMoves: z.boolean().default(true).volatile(),
  maxFlashSeconds: z.number().step(1).min(0).max(86400).default(0).volatile(),
  ignoreInterrupted: z.boolean().default(true).volatile(),
  ignoreSubagent: z.boolean().default(true).volatile(),
  flashTimeout: z.number().step(1).min(0).max(60000).default(0).volatile(),
  flashCount: z.number().step(1).min(0).max(100000).default(0).volatile(),
  pollIntervalMs: z.number().step(1).min(200).max(5000).default(1000).volatile(),
  allowTestFlash: z.boolean().default(true).volatile(),
  trayBlink: z.boolean().default(true).volatile(),
  trayBlinkIntervalMs: z.number().step(1).min(100).max(5000).default(600).volatile(),
  stopWhenDotsClear: z.boolean().default(true).volatile(),
  virtualMainDot: z.boolean().default(true).volatile(),
  dotsStaleSeconds: z.number().step(1).min(5).max(3600).default(60).volatile(),
})

/** Field names whose live value is read through `.get()` on a volatile schema. */
const VOLATILE_KEYS = [
  'enabled', 'triggerComplete', 'triggerPending', 'triggerError',
  'language',
  'soundVolume',
  'triggerWindowHidden', 'triggerWindowBlurred', 'triggerOtherSession',
  'overlayCount', 'tooltipLength', 'overlayCorner',
  'flashCaption', 'onlyWhenUnfocused', 'flashUntilMouseMoves', 'maxFlashSeconds',
  'ignoreInterrupted', 'ignoreSubagent', 'flashTimeout', 'flashCount',
  'pollIntervalMs', 'allowTestFlash', 'trayBlink', 'trayBlinkIntervalMs',
  'stopWhenDotsClear', 'virtualMainDot', 'dotsStaleSeconds',
]

/**
 * Read the live configuration from the parsed schema object.
 *
 * A volatile field is an observable; `.get()` returns its current value. Plain
 * values pass through untouched so the helper stays usable if a field is ever
 * made non-volatile.
 *
 * @param config - the schema-validated configuration object.
 * @returns a plain options object.
 */
function readOptions(config) {
  const options = {}
  for (const key of VOLATILE_KEYS) {
    const value = config?.[key]
    options[key] = value != null && typeof value.get === 'function' ? value.get() : value
  }
  return options
}

/**
 * Pick the badge icon file for an unread count.
 *
 * @param count - total dots (real + virtual).
 * @returns an absolute `.ico` path.
 */
function badgeIconFor(count) {
  if (count > 9) return join(PACKAGE_ROOT, 'assets', 'badge-9plus.ico')
  const n = Math.max(1, Math.trunc(count) || 1)
  return join(PACKAGE_ROOT, 'assets', `badge-${n}.ico`)
}

/** Tray tooltip wording, mirroring the Client half's language setting. */
const TOOLTIP_TEXT = {
  zh: (count) => `${count} 个会话待查看`,
  en: (count) => `${count} ${count > 1 ? 'sessions' : 'session'} unread`,
}

/**
 * Build the tray tooltip for one unread count.
 *
 * @param count - total dots (real + virtual).
 * @param language - `'zh'` or `'en'`; anything else falls back to Chinese.
 * @param maxChars - configured tooltip limit; `szTip` itself holds 127 units.
 */
function trayTooltip(count, language, maxChars) {
  const build = TOOLTIP_TEXT[language] ?? TOOLTIP_TEXT.zh
  const text = build(count)
  const limit = Math.min(127, Math.max(1, Math.trunc(Number(maxChars)) || 127))
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * Register the watcher.
 *
 * @param ctx - Host plugin context.
 * @param config - the schema-validated configuration.
 */
export function apply(ctx, config) {
  // Declare the schema so the Client half can address it through configForms.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const options = readOptions(config)
  if (options.enabled !== true) {
    ctx.logger.info(`${LOG} disabled by config`)
    return
  }

  const { koffi, failures } = loadKoffi({
    onMiss: (misses) => ctx.logger.warn(`${LOG} koffi unavailable, attention flash disabled (${misses.join('; ')})`),
  })
  if (koffi === undefined) {
    if (failures.length > 0) ctx.logger.warn(`${LOG} tried: ${failures.join(' | ')}`)
    return
  }

  let port
  try {
    port = createWin32(koffi)
  } catch (error) {
    ctx.logger.warn(`${LOG} user32 bindings failed, attention flash disabled: ${messageOf(error)}`)
    return
  }

  // The Host runs as a direct child of the Electron main process, which owns the
  // window.
  const pids = [...new Set([process.ppid, process.pid])].filter((pid) => Number.isInteger(pid) && pid > 0)

  // The tray badge is optional in every direction: without shell32 bindings or a
  // discoverable tray host window it stays off and the taskbar flash carries the
  // signal alone.
  let tray
  if (options.trayBlink === true) {
    try {
      const trayPort = createTrayPort(koffi, port.user32, port.shell32, port)
      const resourcesDir = process.resourcesPath ?? join(process.execPath, '..', 'resources')
      tray = createTrayBlink({
        port: trayPort,
        originalIconPath: join(resourcesDir, ORIGINAL_ICON),
        badgeIconFor,
        tooltipFor: (count) => {
          const live = readOptions(config)
          return trayTooltip(count, live.language, live.tooltipLength)
        },
        getCount: () => dots?.total?.() ?? 0,
        pids,
        intervalMs: options.trayBlinkIntervalMs,
        logger: ctx.logger,
      })
    } catch (error) {
      ctx.logger.warn(`${LOG} tray badge unavailable: ${messageOf(error)}`)
      tray = undefined
    }
  }

  // The dots the Client draws in its session list decide when the flash ends.
  const dots = createDots({
    staleSeconds: options.dotsStaleSeconds,
    virtualMain: options.virtualMainDot,
    logger: ctx.logger,
  })

  const attention = createAttention({
    port,
    options,
    pids,
    logger: ctx.logger,
    tray,
    dots,
  })

  ctx.logger.info(`${LOG} watching pid(s) ${pids.join(', ')} (caption=${String(options.flashCaption)}, tray=${String(options.trayBlink)}, dots=${String(options.stopWhenDotsClear)}, poll=${String(options.pollIntervalMs)}ms)`)

  ctx.effect(() => {
    const disposeSession = ctx.on('session/event', (session, event) => {
      observe(attention, session, event, dots.currentSessionId(), options)
    }, { global: true })
    return () => {
      disposeSession()
      attention.dispose()
      port.dispose()
    }
  }, 'whale-reminder: session attention')

  if (options.allowTestFlash === true) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = createSelfTestRoutes({ attention, port, options, logger: webCtx.logger ?? ctx.logger })
      for (const route of routes) {
        webCtx.effect(() => webCtx.webServer.register(route), `whale-reminder: ${route.path}`)
      }
      webCtx.logger?.info?.(`${LOG} self-test routes ${routes.map((route) => route.path).join(', ')}`)
    })
  }
}

/**
 * Map one Session log event onto the attention controller.
 *
 * @param attention - the controller.
 * @param session - emitting Session.
 * @param event - committed Session event.
 * @param mainSessionId - the session the main view retains, when known.
 * @param options - resolved options.
 */
function observe(attention, session, event, mainSessionId, options) {
  switch (event?.type) {
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      if (kind === 'error') {
        if (options.triggerError === true) attention.notifyError(session)
        return
      }
      if (options.triggerComplete === true) {
        attention.notifyTurnEnd(event, session, { isMain: isMainSession(session, mainSessionId) })
      }
      return
    }
    case 'approval/asked':
      if (options.triggerPending === true) attention.notifyApproval(session)
      return
    case 'tool/call':
      if (event.data?.name === QUESTION_TOOL && options.triggerPending === true) attention.notifyQuestion(session)
      return
    default:
      return
  }
}

/**
 * Whether a Session is the one the main view is showing.
 *
 * @param session - the emitting Session.
 * @param mainSessionId - last known main session id.
 * @returns true when this session should raise the virtual dot.
 */
function isMainSession(session, mainSessionId) {
  if (session?.id === undefined || mainSessionId === undefined) return false
  return session.id === mainSessionId
}

/**
 * Reduce an error to one short line.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function messageOf(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}
