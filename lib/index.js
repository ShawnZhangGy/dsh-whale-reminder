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

import { createAttention, isWatchedSession } from './attention.mjs'
import { createDots } from './dots.mjs'
import { loadKoffi } from './koffi-loader.mjs'
import { loadSchemastery } from './schemastery-loader.mjs'
import { createSelfTestRoutes, isLoopbackRequest } from './selftest-route.mjs'
import { createToastSender } from './toast.mjs'
import {
  ACTIVATE_PATH,
  activatePortFrom,
  createActivateRoutes,
  installHandlerScript,
  launchUri,
  registerProtocolHandler,
  activateDiagnostics,
} from './activate-route.mjs'
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

  // Windows notification-centre toasts (Host half).
  systemNotify: z.boolean().default(true).volatile(),
  systemNotifySound: z.boolean().default(false).volatile(),

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
  'language', 'systemNotify', 'systemNotifySound',
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
 * Headline of a system notification, per event kind.
 *
 * Windows shows the headline in bold above the body, so it states the event and
 * nothing else; the session name belongs on the second line.
 */
const TOAST_TEXT = {
  complete: { zh: '会话已完成', en: 'Turn finished' },
  approval: { zh: '等待你的批准', en: 'Approval needed' },
  question: { zh: '等待你的回答', en: 'Your answer is needed' },
  error: { zh: '会话出错', en: 'The turn failed' },
  test: { zh: '测试提醒', en: 'Test reminder' },
}

/**
 * How many characters of the session's own text a toast body may carry.
 *
 * Windows wraps the second line to roughly three lines of text before it starts
 * clipping, and a truncated toast reads as broken rather than concise.
 */
const TOAST_DETAIL_CHARS = 90

/**
 * The last human message in a Session log, as one flat string.
 *
 * The session header deliberately carries no title, and the `sessionTitle`
 * service is not guaranteed to be mounted (and its `snapshotEvents()` read is
 * deprecated), so the first line of the latest user message is the cheapest
 * honest label: it is what the person typed to start the turn.
 *
 * @param session - the emitting Session.
 * @returns the trimmed text, or `undefined` when the log holds none.
 */
function lastUserText(session) {
  let events
  try {
    events = session?.snapshotEvents?.()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    // Developer and tool text is machinery, not something a person typed.
    if (source?.kind !== 'user') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Collapse text into one notification-safe line.
 *
 * @param text - raw text, possibly multi-line.
 * @param maxChars - hard limit.
 * @returns a single line, elided when too long.
 */
function oneLine(text, maxChars) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`
}

/**
 * Build the toast content for one event.
 *
 * @param kind - `'complete'`, `'approval'`, `'question'`, `'error'` or `'test'`.
 * @param session - the emitting Session, when there is one.
 * @param options - resolved options (for `language`).
 * @returns `{ headline, detail, silent }`.
 */
function toastContent(kind, session, options) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const headline = TOAST_TEXT[kind]?.[language] ?? TOAST_TEXT.complete[language]
  const text = session === undefined ? undefined : lastUserText(session)
  const detail = text !== undefined && text.length > 0
    ? oneLine(text, TOAST_DETAIL_CHARS)
    // No readable text: the id at least tells two sessions apart.
    : typeof session?.id === 'string' ? session.id.slice(0, 8) : undefined
  // `systemNotifySound` off means the toast stays silent; the Client half's own
  // Web Audio cues are a separate channel with its own volume.
  //
  // The launch URI is what turns the toast into a door: a click re-enters the
  // plugin's own protocol handler, which leaves the session id for the Client
  // half to pick up. A toast for an unknown session still opens the window.
  return {
    headline,
    detail,
    silent: options.systemNotifySound !== true,
    launch: launchUri(session?.id),
  }
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

  // System notifications ride a different backend from the taskbar flash: the
  // flash needs koffi and a resolvable window, the toast needs only PowerShell's
  // WinRT bridge. The sender is built first so that a machine where the Win32
  // bindings fail still gets the notification channel.
  let toast
  try {
    toast = createToastSender({
      iconPath: join(PACKAGE_ROOT, 'assets', 'icon-180.png'),
      displayName: options.language === 'en' ? 'Whale Reminder' : '鲸鱼提醒',
      logger: ctx.logger,
    })
    if (toast.supported !== true) toast = undefined
  } catch (error) {
    ctx.logger.warn(`${LOG} system notifications unavailable: ${messageOf(error)}`)
    toast = undefined
  }

  // Without the Win32 bindings there is no flash, no dots and no tray badge, but
  // a toast still tells the person their turn ended. Both degraded exits share
  // this single subscription so the two cannot drift apart.
  const subscribeNotificationsOnly = () => {
    if (toast === undefined) return
    ctx.effect(() => {
      const disposeSession = ctx.on('session/event', (session, event) => {
        observe(undefined, session, event, undefined, options, toast)
      }, { global: true })
      return () => {
        disposeSession()
      }
    }, 'whale-reminder: session notifications')
  }

  const { koffi, failures } = loadKoffi({
    onMiss: (misses) => ctx.logger.warn(`${LOG} koffi unavailable, attention flash disabled (${misses.join('; ')})`),
  })
  if (koffi === undefined) {
    if (failures.length > 0) ctx.logger.warn(`${LOG} tried: ${failures.join(' | ')}`)
    subscribeNotificationsOnly()
    return
  }

  let port
  try {
    port = createWin32(koffi)
  } catch (error) {
    ctx.logger.warn(`${LOG} user32 bindings failed, attention flash disabled: ${messageOf(error)}`)
    subscribeNotificationsOnly()
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
      observe(attention, session, event, dots.currentSessionId(), options, toast)
    }, { global: true })
    return () => {
      disposeSession()
      attention.dispose()
      port.dispose()
    }
  }, 'whale-reminder: session attention')

  // Toast clicks are a core part of the feature, not a diagnostic, so the
  // activation bridge is wired even when the self-test routes are switched off.
  // It is also independent of koffi: a machine without the Win32 bindings still
  // gets notifications and still gets navigation from them.
  //
  // Order matters. The handler reports a click back over loopback, so the port
  // must be known before the registry command can name it, and the port only
  // exists once the web server has bound its listener. Registering the route
  // first is safe at any time; reading the origin may not be, so it retries.
  ctx.inject(['webServer'], (webCtx) => {
    const logger = webCtx.logger ?? ctx.logger
    const routes = createActivateRoutes({ isLoopbackRequest, logger })
    for (const route of routes) {
      webCtx.effect(() => webCtx.webServer.register(route), `whale-reminder: ${route.path}`)
    }

    whenOriginReady(webCtx.webServer, (loopbackPort) => {
      if (loopbackPort === undefined) {
        logger?.warn?.(`${LOG} loopback origin unavailable, toast clicks will only raise the window`)
        return
      }
      try {
        const handlerPath = installHandlerScript(join(PACKAGE_ROOT, 'assets', 'activate.exe'), logger)
        if (handlerPath === undefined) return
        const registered = registerProtocolHandler({ handlerPath, port: loopbackPort, logger })
        if (registered) logger?.info?.(`${LOG} toast activation route ${ACTIVATE_PATH} (port ${loopbackPort})`)
        else logger?.warn?.(`${LOG} toast clicks will only raise the window`)
      } catch (error) {
        logger?.warn?.(`${LOG} activation bridge unavailable: ${messageOf(error)}`)
      }
    }, logger)
  })

  if (options.allowTestFlash === true) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = createSelfTestRoutes({
        attention,
        port,
        options,
        toast,
        activateDiagnostics,
        launchUri,
        currentSessionId: () => dots.currentSessionId(),
        logger: webCtx.logger ?? ctx.logger,
      })
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
 * @param toast - system-notification sender, when the platform has one.
 */
function observe(attention, session, event, mainSessionId, options, toast) {
  switch (event?.type) {
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      if (kind === 'error') {
        if (options.triggerError === true) {
          attention?.notifyError(session)
          notifySystem(toast, 'error', session, options)
        }
        return
      }
      if (options.triggerComplete === true) {
        attention?.notifyTurnEnd(event, session, { isMain: isMainSession(session, mainSessionId) })
        notifySystem(toast, 'complete', session, options)
      }
      return
    }
    case 'approval/asked':
      if (options.triggerPending === true) {
        attention?.notifyApproval(session)
        notifySystem(toast, 'approval', session, options)
      }
      return
    case 'tool/call':
      if (event.data?.name === QUESTION_TOOL && options.triggerPending === true) {
        attention?.notifyQuestion(session)
        notifySystem(toast, 'question', session, options)
      }
      return
    default:
      return
  }
}

/**
 * Raise a system notification for one event, honouring the switch and the
 * sub-agent rule.
 *
 * The sub-agent rule is applied here rather than inside the toast sender: a
 * delegated turn ends constantly and its completion is not something a person
 * waits for, which is the same reason the taskbar flash skips it.
 *
 * @param toast - the sender, or `undefined` when the platform or config has none.
 * @param kind - event kind understood by {@link toastContent}.
 * @param session - the emitting Session.
 * @param options - resolved options.
 * @returns the sender's result, or `undefined` when nothing was attempted.
 */
function notifySystem(toast, kind, session, options) {
  if (toast === undefined) return undefined
  if (options.systemNotify !== true) return undefined
  if (session !== undefined && !isWatchedSession(session, options)) return undefined
  // The sender is written never to throw; this guard keeps a surprising failure
  // from escaping into the Session event dispatch and disturbing other plugins.
  try {
    return toast.show(toastContent(kind, session, options))
  } catch {
    return undefined
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

/**
 * Call back once the web server knows its own port.
 *
 * `getOrigin()` throws until the listener is bound, and a plugin may be loaded
 * before that happens. Polling is bounded so a server that never comes up costs
 * one warning, not a timer that outlives the plugin.
 *
 * Exported for the regression probe; it is not part of the plugin contract.
 *
 * @param server - the `webServer` service.
 * @param done - called once with the loopback port, or undefined when unavailable.
 * @param logger - Host logger.
 */
export function whenOriginReady(server, done, logger) {
  const MAX_ATTEMPTS = 20
  const RETRY_MS = 250
  let attempts = 0
  let timer

  // A server object without the method will never grow one; do not wait 10s.
  if (typeof server?.getOrigin !== 'function') {
    done(undefined)
    return
  }

  const attempt = () => {
    attempts += 1
    let origin
    try {
      origin = server.getOrigin()
    } catch {
      // Not bound yet; try again shortly.
    }
    const port = activatePortFrom(origin)
    if (port !== undefined) {
      done(port)
      return
    }
    if (attempts >= MAX_ATTEMPTS) {
      logger?.warn?.(`${LOG} gave up waiting for the loopback port after ${attempts} attempts`)
      done(undefined)
      return
    }
    // Deliberately not unref'd: an unref'd retry never fires when nothing else
    // keeps the loop alive, which would drop the bridge on a quiet start. The
    // wait is bounded, so holding the loop for at most MAX_ATTEMPTS * RETRY_MS
    // is acceptable.
    timer = setTimeout(attempt, RETRY_MS)
  }

  attempt()
}
