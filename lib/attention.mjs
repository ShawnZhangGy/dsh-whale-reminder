/**
 * The attention state machine: when to start flashing, when to stop.
 *
 * This module owns every decision and no I/O. It is handed a window port
 * (see `win32.mjs`), a clock, and a timer factory, which is what lets the whole
 * policy — deduplication, the stop rule, the deadline, the interrupt filter —
 * be tested without a real screen.
 *
 * The lifecycle is deliberately one-way: the first qualifying event starts a
 * flash, later events join the same flash instead of restarting it, and one
 * condition ends it.
 *
 * ## The stop rule
 *
 * The flash is tied to the **attention dots** the Client draws in its session
 * list, not to window focus. A yellow dot means an approval, a plan review or a
 * question is waiting; a green dot means a background session finished and
 * nobody looked. The flash lasts until no dot is left:
 *
 * - The main session never earns a real green dot, so it raises a *virtual* one
 *   that clears when the window comes back to the foreground.
 * - When the Client cannot be reached (never loaded, or silent past the staleness
 *   window), the dots are *unknown*, and the rule falls back to focus so a
 *   missing Client cannot produce a flash that never ends.
 *
 * @module dsh-whale-reminder/attention
 */

/** Kinds of attention this plugin reacts to. */
export const SOURCE = {
  /** A turn finished: the answer is ready and nobody has read it. */
  turnEnd: 'turn-end',
  /** A tool is blocked on a human approval decision. */
  approval: 'approval',
  /** The model asked a question, including a plan submitted for review. */
  question: 'question',
  /** A turn ended with an error. */
  error: 'error',
}

/** Why a running flash was cancelled. */
export const STOP = {
  /** The dots cleared: everything that wanted attention has been seen. */
  dotsCleared: 'dots-cleared',
  /** Fell back to focus because the Client's dot report is not available. */
  focused: 'focused',
  /** The pointer moved, which is how a focused attempt is acknowledged. */
  mouseMoved: 'mouse-moved',
  /** The person switched to another session, so this one has been seen. */
  sessionSwitched: 'session-switched',
  /** The window stopped being the foreground one while awaiting a mouse move. */
  blurred: 'blurred',
  windowGone: 'window-gone',
  timeout: 'timeout',
  disabled: 'disabled',
  disposed: 'disposed',
  stopped: 'stopped',
}

/**
 * Human-readable explanations for the log, one line each.
 *
 * @param event - a `session/event` payload's type and data.
 * @returns true when the turn ended in a way the user should be told about.
 */
function isNoteworthyTurnEnd(event, options) {
  if (event?.type !== 'turn/end') return false
  const kind = event.data?.reason?.kind
  if (kind === undefined) return true
  if (kind === 'interrupted' || kind === 'aborted' || kind === 'cancelled') {
    return options.ignoreInterrupted !== true
  }
  return true
}

/**
 * Decide whether one session may raise attention at all.
 *
 * Sub-agent sessions are excluded by default because their turns end constantly
 * and the parent turn is the event a person actually waits for.
 *
 * @param session - the Session that emitted the event.
 * @param options - resolved plugin options.
 * @returns true when this session is allowed to raise attention.
 */
function isWatchedSession(session, options) {
  if (options.ignoreSubagent !== true) return true
  const header = session?.header
  if (header === undefined || header === null) return true
  if (header.origin === 'subagent') return false
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return false
  return true
}

/**
 * Build the attention controller.
 *
 * @param dependencies - window port, options, and injectable clock/timer/logger.
 * @returns the controller.
 */
export function createAttention(dependencies) {
  const {
    port,
    options,
    pids,
    logger,
    tray,
    dots,
    now = () => Date.now(),
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (handle) => clearInterval(handle),
  } = dependencies

  /** Sessions/approvals that arrived while nobody was looking. */
  const pending = new Set()
  /** Reasons collected since the flash started, for the diagnostic log. */
  let reasons = []
  let timer
  let hwnd
  let startedAt
  let deadlineAt
  let lastStop
  let disposed = false
  /**
   * Whether this flash is waiting on a mouse move rather than on the dots.
   *
   * Set when the turn that triggered the flash belongs to the session already on
   * screen *and* the window already has the foreground: there is no dot to wait
   * for in that case (the main session never earns one), yet the answer is still
   * worth announcing. The pointer becomes the "I have seen it" signal instead of
   * focus, so the flash does not end in the same tick it began.
   */
  let awaitingMouse = false
  /** Pointer position when the flash started, for the move comparison. */
  let cursorAtStart
  /** Session that was on screen when the flash started, for switch detection. */
  let sessionAtStart

  /**
   * Resolve the Harness window, trying each candidate process id in order.
   *
   * @returns the window descriptor, or `undefined` when none is visible yet.
   */
  function resolveWindow() {
    if (hwnd !== undefined && port.isLive(hwnd)) return { hwnd }
    hwnd = undefined
    for (const pid of pids) {
      const found = port.findMainWindow(pid)
      if (found !== undefined) {
        hwnd = found.hwnd
        return found
      }
    }
    return undefined
  }

  /**
   * Cancel the running flash and forget the pending reasons.
   *
   * @param cause - one of {@link STOP}.
   * @returns the stop cause.
   */
  function stopFlashing(cause) {
    if (timer !== undefined) {
      clearIntervalFn(timer)
      timer = undefined
    }
    const target = hwnd
    pending.clear()
    startedAt = undefined
    deadlineAt = undefined
    awaitingMouse = false
    cursorAtStart = undefined
    sessionAtStart = undefined
    if (target !== undefined) {
      try {
        port.stop(target)
      } catch (error) {
        logger?.warn?.(`whale-reminder: stop failed: ${describe(error)}`)
      }
    }
    // The tray image is restored on every stop path, so a blink can never be
    // left running by a thrown error or a closed window.
    try {
      tray?.stop()
    } catch (error) {
      logger?.warn?.(`whale-reminder: tray restore failed: ${describe(error)}`)
    }
    lastStop = cause
    return cause
  }

  /**
   * Evaluate the conditions that end a flash without an outside event.
   *
   * Runs on the interval rather than on a focus hook because the OS gives a
   * process no callback when another window takes the foreground, and the dot
   * counts arrive asynchronously over HTTP.
   *
   * The primary rule is "keep flashing while a dot remains". Focus is only the
   * fallback: it applies when the dots are *unknown* (no Client, or a Client that
   * stopped reporting), and it also clears the main session's virtual dot, which
   * is how a person acknowledging a main-session turn answers it.
   */
  function tick() {
    if (disposed) return
    if (hwnd === undefined) {
      stopFlashing(STOP.windowGone)
      return
    }
    if (!port.isLive(hwnd)) {
      stopFlashing(STOP.windowGone)
      return
    }

    // Waiting on the pointer: this flash was raised by the session already on
    // screen, so focus alone is not the acknowledgement — the person may be
    // reading the answer without having touched anything. The pointer moving,
    // switching session, or leaving the window ends it.
    //
    // A real yellow/green dot outranks the pointer. One can appear after this
    // wait was armed (an approval arrives, or a background session finishes),
    // and by then the person has something to look at in the session list; the
    // rule the plugin exists for is "flash until no dot is left", so the pointer
    // must not cut that short. Disarm and fall through to the dot rule.
    if (awaitingMouse) {
      if (dots?.hasRealDots?.() === true) {
        awaitingMouse = false
      } else {
        if (!port.isForeground(hwnd)) {
          stopFlashing(STOP.blurred)
          return
        }
        const current = dots?.currentSessionId?.()
        if (sessionAtStart !== undefined && current !== undefined && current !== sessionAtStart) {
          stopFlashing(STOP.sessionSwitched)
          return
        }
        if (port.cursorMoved?.(cursorAtStart, port.cursorPosition?.()) === true) {
          stopFlashing(STOP.mouseMoved)
          return
        }
        if (deadlineAt !== undefined && now() >= deadlineAt) {
          stopFlashing(STOP.timeout)
        }
        return
      }
    }

    // A person looking at the window has seen whatever the main session produced,
    // so that virtual dot is answered by focus rather than by a Client report.
    // This runs *before* the dot check on purpose: clearing the virtual dot first
    // means a main-session turn cannot be cancelled in the same tick that started
    // it, and a real dot from a background session keeps the flash alive anyway.
    if (port.isForeground(hwnd)) dots?.noteFocused?.()
    dots?.warnIfStale?.()

    if (dots !== undefined && options.stopWhenDotsClear === true) {
      const remaining = dots.hasDots()
      if (remaining === false) {
        stopFlashing(STOP.dotsCleared)
        return
      }
      if (remaining === undefined) {
        // Unknown: the Client is not answering. Fall back to focus so a broken
        // page cannot leave a flash running until the deadline.
        if (port.isForeground(hwnd)) {
          stopFlashing(STOP.focused)
          return
        }
      }
      // remaining === true: dots are still showing, keep flashing.
    } else if (options.onlyWhenUnfocused === true && port.isForeground(hwnd)) {
      stopFlashing(STOP.focused)
      return
    }

    if (deadlineAt !== undefined && now() >= deadlineAt) {
      stopFlashing(STOP.timeout)
    }
  }

  /**
   * Start a flash for one window, if the current conditions allow it.
   *
   * This is the shared tail of {@link notify} and {@link evaluate}: one place that
   * decides whether to begin, so the event path and the dot path cannot drift
   * apart. It assumes the caller has already resolved the window.
   *
   * @param window - the window descriptor from `resolveWindow`.
   * @param kind - what triggered this, for the log and the diagnostic snapshot.
   * @returns a result describing the decision.
   */
  function startFlash(window, kind) {
    reasons = [kind]
    startedAt = now()
    deadlineAt = options.maxFlashSeconds > 0
      ? startedAt + options.maxFlashSeconds * 1000
      : undefined

    const realDots = dots?.hasRealDots?.()
    const wantsMouse = options.flashUntilMouseMoves === true
      && kind !== 'self-test'
      && realDots !== true
      && port.isForeground(window.hwnd)

    cursorAtStart = wantsMouse ? port.cursorPosition?.() : undefined
    awaitingMouse = wantsMouse && cursorAtStart !== undefined
    sessionAtStart = awaitingMouse ? dots?.currentSessionId?.() : undefined

    let raw
    try {
      raw = port.flash(window.hwnd, {
        caption: options.flashCaption === true,
        count: options.flashCount,
        timeout: options.flashTimeout,
      })
    } catch (error) {
      hwnd = undefined
      awaitingMouse = false
      return { started: false, reason: 'flash-failed', error: describe(error) }
    }

    timer = setIntervalFn(tick, clampInterval(options.pollIntervalMs))
    if (typeof timer?.unref === 'function') timer.unref()
    let trayStarted = false
    if (options.trayBlink === true && tray !== undefined) {
      try {
        trayStarted = tray.start()
      } catch (error) {
        logger?.warn?.(`whale-reminder: tray blink failed: ${describe(error)}`)
      }
    }
    logger?.info?.(`whale-reminder: started ${kind ?? 'attention'} on window ${handleText(window.hwnd)} (raw=${String(raw)}, tray=${trayStarted ? 'on' : 'off'}, dots=${String(dots?.total?.() ?? 'n/a')})`)
    return { started: true, hwnd: window.hwnd, raw, tray: trayStarted, pending: pending.size }
  }

  /**
   * Decide whether the current dot state justifies a flash, and start one.
   *
   * @param kind - what triggered this evaluation, for the log.
   * @returns a result describing the decision.
   */
  function evaluate(kind) {
    if (disposed) return { started: false, reason: 'disposed' }
    if (options.enabled !== true) return { started: false, reason: 'disabled' }
    if (port === undefined) return { started: false, reason: 'no-ffi' }
    if (timer !== undefined) return { started: false, reason: 'already-flashing' }

    const window = resolveWindow()
    if (window === undefined) return { started: false, reason: 'no-window' }

    if (options.stopWhenDotsClear === true && dots !== undefined) {
      const remaining = dots.hasDots()
      if (remaining === false) {
        return { started: false, reason: 'no-dots', hwnd: window.hwnd }
      }
      if (remaining === true) return startFlash(window, kind)
      if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
        return { started: false, reason: 'focused', hwnd: window.hwnd }
      }
      return { started: false, reason: 'unknown-dots', hwnd: window.hwnd }
    }

    if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
      return { started: false, reason: 'focused', hwnd: window.hwnd }
    }
    return startFlash(window, kind)
  }

  /**
   * Raise attention for one event.
   *
   * @param request - what happened and which session it came from.
   * @returns a result describing the decision, for tests and the diagnostic log.
   */
  function notify(request) {
    const kind = request?.kind
    const sessionId = request?.sessionId
    if (disposed) return { started: false, reason: 'disposed' }
    if (options.enabled !== true) return { started: false, reason: 'disabled' }
    if (port === undefined) return { started: false, reason: 'no-ffi' }
    if (request?.session !== undefined && !isWatchedSession(request.session, options)) {
      return { started: false, reason: 'ignored-session' }
    }

    const alreadyFlashing = timer !== undefined
    if (sessionId !== undefined) pending.add(sessionId)

    const virtualRaised = dots?.noteTurnEnd?.(sessionId, request?.isMain === true) === true

    const window = resolveWindow()
    if (window === undefined) {
      return { started: false, reason: 'no-window', pending: pending.size }
    }
    if (options.stopWhenDotsClear === true && dots !== undefined) {
      const remaining = dots.hasDots()
      if (remaining === false && virtualRaised !== true) {
        return { started: false, reason: 'no-dots', hwnd: window.hwnd, pending: pending.size }
      }
      if (remaining === undefined && options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
        return { started: false, reason: 'focused', hwnd: window.hwnd, pending: pending.size }
      }
    } else if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
      return { started: false, reason: 'focused', hwnd: window.hwnd, pending: pending.size }
    }
    if (alreadyFlashing) {
      reasons.push(kind)
      return { started: false, reason: 'already-flashing', hwnd: window.hwnd, pending: pending.size }
    }

    return startFlash(window, kind)
  }

  /** Manually stop a flash, used by the self-test route and by disposal. */
  function stop(cause = STOP.stopped) {
    return stopFlashing(cause)
  }

  /**
   * Unconditionally demonstrate the flash for the settings page's test button.
   *
   * Unlike {@link notify}, this ignores the dot rule and the focus rule: the
   * point of a test button is to show the effect even when nothing is waiting,
   * so the person configuring the plugin can see and hear exactly what will
   * happen. It still resolves a real window and shares `startFlash`, so the
   * deadline and timer behaviour stay identical.
   *
   * @returns the same shape as `notify`, so the self-test route can reuse it.
   */
  function selfTest() {
    if (disposed) return { started: false, reason: 'disposed' }
    if (options.enabled !== true) return { started: false, reason: 'disabled' }
    if (port === undefined) return { started: false, reason: 'no-ffi' }
    if (timer !== undefined) return { started: false, reason: 'already-flashing' }
    const window = resolveWindow()
    if (window === undefined) return { started: false, reason: 'no-window' }
    return startFlash(window, 'self-test')
  }

  /** Release the timer and the tray icons; later calls become no-ops. */
  function dispose() {
    if (disposed) return
    if (timer !== undefined) stopFlashing(STOP.disposed)
    try {
      tray?.dispose()
    } catch (error) {
      logger?.warn?.(`whale-reminder: tray cleanup failed: ${describe(error)}`)
    }
    disposed = true
  }

  return {
    notify,
    selfTest,
    notifyTurnEnd(event, session, context) {
      if (!isNoteworthyTurnEnd(event, options)) {
        return { started: false, reason: 'ignored-interrupted' }
      }
      return notify({
        kind: SOURCE.turnEnd,
        session,
        sessionId: session?.id,
        isMain: context?.isMain === true,
        event,
      })
    },
    notifyApproval(session) {
      return notify({ kind: SOURCE.approval, session, sessionId: session?.id })
    },
    notifyQuestion(session) {
      return notify({ kind: SOURCE.question, session, sessionId: session?.id })
    },
    notifyError(session) {
      return notify({ kind: SOURCE.error, session, sessionId: session?.id })
    },
    updateDots(report) {
      const snapshot = dots?.update?.(report)
      const after = dots?.total?.() ?? 0
      if (timer === undefined && after > 0) evaluate('dots')
      return snapshot
    },
    clearDots() {
      dots?.clear?.()
    },
    tick,
    stop,
    dispose,
    snapshot() {
      return {
        flashing: timer !== undefined,
        pending: [...pending],
        reasons: [...reasons],
        hwnd,
        startedAt,
        deadlineAt,
        lastStop,
        disposed,
        tray: tray?.snapshot?.(),
        dots: dots?.snapshot?.(),
      }
    },
  }
}

/**
 * Keep the poll interval inside a range that cannot pin a core or stall the stop.
 *
 * @param value - configured interval in milliseconds.
 * @returns the clamped interval.
 */
export function clampInterval(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1000
  return Math.min(5000, Math.max(200, Math.trunc(number)))
}

/**
 * Render a window handle for a log line.
 *
 * @param hwnd - handle as bigint or number.
 * @returns hexadecimal text.
 */
export function handleText(hwnd) {
  try {
    return `0x${BigInt(hwnd).toString(16)}`
  } catch {
    return String(hwnd)
  }
}

/**
 * Reduce an error to one short line.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}

export { isNoteworthyTurnEnd, isWatchedSession }
