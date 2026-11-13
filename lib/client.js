/**
 * Client half of `dsh-whale-reminder`: sound, floating summary and the
 * settings page, plus the dot report the Host needs to flash.
 *
 * The Host owns the tray icon and the taskbar flash; this half owns everything
 * the page can do for itself — play the two sounds, draw the floating badge,
 * and present the configuration page the plugin-manager opens for this row.
 * It also tells the Host how many attention dots the sidebar is showing, which
 * is the only fact the Host needs to decide when to start and stop flashing.
 *
 * ```
 * completionUnread   → green dot  → "complete" sound
 * pendingInteraction → yellow dot → "pending" sound
 * ```
 *
 * ## Why a hand-written bundle
 *
 * This package ships no bundler step. DSH loads a client half by evaluating
 * `lib/client.js` in the page, where it must call `window.__ModuleLoader__.load`
 * and register itself under the package name. That is the same shape the shipped
 * and third-party client plugins use, so it is written out literally here.
 *
 * @module dsh-whale-reminder/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-reminder',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace; must match the row id so translations resolve. */
    const NS = 'dsh-whale-reminder'

    /** Route the Host listens on for dot reports. */
    const DOTS_PATH = '/__whale-reminder/dots'

    /** Route the Host listens on to run a self-test flash. */
    const TEST_FLASH_PATH = '/__whale-reminder/self-test'

    /** Polled for a session id left by a clicked Windows toast. */
    const ACTIVATE_PATH = '/__whale-reminder/activate'

    /** Toast-click poll cadence: brisk while the window is behind something. */
    const ACTIVATE_POLL_BACKGROUND_MS = 1_500

    /** Toast-click poll cadence while the window already has focus. */
    const ACTIVATE_POLL_FOCUSED_MS = 5_000

    /** Minimum gap between two reports, so a busy session list cannot flood the Host. */
    const THROTTLE_MS = 250

    /** Keep-alive beat so an unchanged dot is not read as "no Client". */
    const HEARTBEAT_MS = 30_000

    /** Package name the Host's config namespace is addressed under. */
    const CONFIG_NS = 'dsh-whale-reminder'

    /** Key the plugin-manager uses to open this row's own config page. */
    const ROW_CONFIG_KEY = 'dsh-whale-reminder#dsh-whale-reminder'

    /** Shared empty set, so `countDots` need not allocate one per tick. */
    const EMPTY_SET = new Set()

    /** A source that never reports archived sessions, used before wiring exists. */
    const EMPTY_ARCHIVED_SOURCE = { getSnapshot: () => EMPTY_SET, subscribe: () => () => {} }

    /** Session metadata reported before the wiring exists. */
    const EMPTY_SESSION_META = { byId: {}, current: undefined }

    /** A source that never reports sessions, used before wiring exists. */
    const EMPTY_SESSIONS_SOURCE = { getSnapshot: () => EMPTY_SESSION_META, subscribe: () => () => {} }

    // ------------------------------------------------------------------
    // Locale dictionaries (kept inline so no JSON import is needed).
    // ------------------------------------------------------------------
    const DICT_ZH = {
      meta: { title: 'whale reminder' },
      settings: {
        soundVolume: '声音音量',
        soundVolumeHint: '两个音效共用此音量',
        playTest: '试听',
        triggerWindowHidden: '窗口被隐藏时提醒',
        triggerWindowBlurred: '窗口失焦时提醒',
        triggerOtherSession: '焦点在别的会话时提醒',
        triggerComplete: '正常完成',
        triggerPending: '待回答',
        triggerError: '出错',
        overlayCount: '浮层显示会话数',
        overlayCountUnit: '个',
        tooltipLength: 'tooltip 字数上限',
        overlayCorner: '浮层停靠角落',
        testButton: '测试提醒',
        testButtonHint: '一键演练：闪任务栏 + 闪托盘 + 出声 + 浮层出现',
        rowSummary: '会话结束提醒：声音 + 浮层 + 任务栏/托盘闪烁',
        sectionLabel: '鲸鱼提醒',
        language: '语言',
        languageHint: '仅影响本插件的声音提示、浮层与设置页',
        triggers: '提醒哪些事件',
        attention: '什么时候算「需要提醒」',
        soundsOverlay: '声音与浮层',
        systemNotify: '系统通知',
        systemNotifyHint: '在 Windows 通知中心弹出横幅；关闭后不影响任务栏与托盘',
        systemNotifySound: '通知带提示音',
        systemNotifySoundHint: '使用 Windows 通知自带的提示音；与本插件的音效相互独立',
        systemNotifyOnlyWhenUnfocused: 'DSH 在前台时不弹通知',
        systemNotifyOnlyWhenUnfocusedHint: '只有在 DSH 被其他窗口盖住或最小化时才弹出；声音与角落徽章不受影响',
        clickAction: '点击通知时',
        clickActionHint: '不管选哪一项，会话都会切过去',
        clickRaise: '提到最前并聚焦输入框',
        clickRaiseHint: '推荐。窗口会到最层，光标进入输入框，可以立即打字；代价是会从其他程序里抢走键盘焦点',
        clickShow: '只提到最前，不抢键盘',
        clickShowHint: '窗口会到最层，但不会从你正在输入的地方抢走焦点',
        clickNone: '只提醒，不提窗',
        clickNoneHint: '窗口保持原样（可能还在任务栏里），只切换会话；适合不想被打断的场合',
        enabled: '启用提醒',
        enabledHint: '总开关：关闭后不出声、不闪任务栏、不显示浮层',
      },
      overlay: {
        unread: '个会话未读',
        latest: '最新',
        more: '还有 {n} 个未读',
        expand: '展开',
        clear: '清除',
        open: '点击打开该会话',
      },
      corner: {
        bottomRight: '右下角',
        bottomLeft: '左下角',
        topRight: '右上角',
        topLeft: '左上角',
      },
    }

    const DICT_EN = {
      meta: { title: 'whale reminder' },
      settings: {
        soundVolume: 'Sound volume',
        soundVolumeHint: 'Shared by both sounds',
        playTest: 'Preview',
        triggerWindowHidden: 'Remind when window hidden',
        triggerWindowBlurred: 'Remind when window blurred',
        triggerOtherSession: 'Remind when focus is on another session',
        triggerComplete: 'Completed',
        triggerPending: 'Awaiting answer',
        triggerError: 'Error',
        overlayCount: 'Sessions shown in overlay',
        overlayCountUnit: 'sessions',
        tooltipLength: 'Tooltip char limit',
        overlayCorner: 'Overlay corner',
        testButton: 'Test reminder',
        testButtonHint: 'Run the full rehearsal: taskbar flash, tray flash, sound, overlay',
        rowSummary: 'Session-finish reminders: sound, floating badge, taskbar/tray flash',
        sectionLabel: 'Whale Reminder',
        language: 'Language',
        languageHint: "Affects only this plugin's sound cues, overlay and settings page",
        triggers: 'Which events to remind about',
        attention: 'What counts as needing attention',
        soundsOverlay: 'Sound and overlay',
        systemNotify: 'System notification',
        systemNotifyHint: 'Show a Windows notification banner; off leaves the taskbar and tray untouched',
        systemNotifySound: 'Play a notification sound',
        systemNotifySoundHint: "Uses the Windows notification sound; independent of this plugin's own cues",
        systemNotifyOnlyWhenUnfocused: 'No notification while DSH is in front',
        systemNotifyOnlyWhenUnfocusedHint: 'Only pops when DSH is covered or minimised; sound and the corner badge are unaffected',
        clickAction: 'When a notification is clicked',
        clickActionHint: 'The session switches either way',
        clickRaise: 'Raise the window and focus the input',
        clickRaiseHint: 'Recommended. The window comes to the front with the cursor in the input, ready to type; the cost is that it takes the keyboard from whatever you were doing',
        clickShow: 'Raise the window, leave the keyboard',
        clickShowHint: 'The window comes to the front but will not take the focus from what you are typing in',
        clickNone: 'Notify only, leave the window alone',
        clickNoneHint: 'The window stays as it is (possibly still minimised) and only the session changes; for when you do not want to be interrupted',
        enabled: 'Enable reminders',
        enabledHint: 'Master switch: off means no sound, no taskbar flash, no overlay',
      },
      overlay: {
        unread: 'unread',
        latest: 'latest',
        more: '{n} more unread',
        expand: 'Expand',
        clear: 'Clear',
        open: 'Open this session',
      },
      corner: {
        bottomRight: 'Bottom right',
        bottomLeft: 'Bottom left',
        topRight: 'Top right',
        topLeft: 'Top left',
      },
    }

    /** Languages this plugin offers for its own surfaces. */
    const DICTS = { zh: DICT_ZH, en: DICT_EN }

    /** Default language; Chinese, matching the primary audience. */
    const DEFAULT_LANGUAGE = 'zh'

    /** Read one dotted key out of a locale dictionary. */
    function lookup(dict, key) {
      let node = dict
      for (const part of key.split('.')) {
        if (node === undefined || node === null) return undefined
        node = node[part]
      }
      return typeof node === 'string' ? node : undefined
    }

    /**
     * Build a translator for one explicit language.
     *
     * The plugin keeps its own language switch instead of following the app
     * locale: someone running the app in English may still want these reminders
     * in Chinese, and the settings page has to stay readable while they flip it.
     */
    function makeT(language) {
      const dict = DICTS[language] ?? DICTS[DEFAULT_LANGUAGE]
      return (key) => lookup(dict, key) ?? lookup(DICTS[DEFAULT_LANGUAGE], key) ?? key
    }

    /** Cached translators, so re-renders do not rebuild one per string. */
    const TRANSLATORS = new Map()
    function translatorFor(language) {
      const key = DICTS[language] ? language : DEFAULT_LANGUAGE
      let cached = TRANSLATORS.get(key)
      if (cached === undefined) {
        cached = makeT(key)
        TRANSLATORS.set(key, cached)
      }
      return cached
    }

    // ------------------------------------------------------------------
    // Dot counting and Host reporting (same contract as dsh-tray-flash).
    // ------------------------------------------------------------------

    /**
     * Count the dots the sidebar is currently showing.
     *
     * `archived` holds session ids the user already filed away: an archived
     * session keeps its `completionUnread` flag (only the official code clears
     * that), but the user has demonstrably dealt with it, so it must not keep
     * ringing this plugin's bell.
     */
    function countDots(statuses, archived, meta) {
      const counts = { approval: 0, question: 0, unread: 0 }
      if (statuses === undefined || statuses === null) return { ...counts, total: 0 }
      const skip = archived ?? EMPTY_SET
      const pairs = typeof statuses.entries === 'function' ? [...statuses.entries()] : Object.entries(statuses)
      for (const [sessionId, status] of pairs) {
        if (status === undefined || status === null) continue
        if (skip.has(sessionId)) continue
        if (!sessionShown(sessionId, meta ?? EMPTY_SESSION_META, skip)) continue
        if (status.completionUnread === true) counts.unread += 1
        const kind = status.pendingInteraction?.kind
        if (kind === 'approval') counts.approval += 1
        else if (kind === 'question' || kind === 'plan-review') counts.question += 1
      }
      return { ...counts, total: counts.approval + counts.question + counts.unread }
    }

    /** Find the session the main view is showing, if any. */
    function currentSessionId(uiSession) {
      try {
        const current = uiSession?.current?.getSnapshot?.()
        const key = current?.key ?? current?.sessionId
        return typeof key === 'string' && key.length > 0 ? key : undefined
      } catch {
        return undefined
      }
    }

    /** Post one report to the Host; never rejects. */
    async function report(payload) {
      try {
        await fetch(DOTS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        })
      } catch {
        // The Host may be restarting, or this page may be closing.
      }
    }

    /** Tell the Host the dots are gone when this half unloads. */
    function clearOnUnload() {
      try {
        // `fetch` reports transport failures asynchronously, so the surrounding
        // try/catch cannot see them: swallow the rejection explicitly.
        fetch(DOTS_PATH, { method: 'DELETE', credentials: 'same-origin', keepalive: true })?.catch?.(() => {})
      } catch {
        // Nothing to do.
      }
    }

    // ------------------------------------------------------------------
    // Sound (Web Audio).
    // ------------------------------------------------------------------
    let audioContext
    function ensureAudio() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return undefined
        if (audioContext === undefined) audioContext = new Ctor()
        if (audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {})
        }
        return audioContext
      } catch {
        return undefined
      }
    }

    /** One short oscillator note. */
    function tone(ctx, frequency, startAt, duration, volume) {
      try {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = frequency
        const now = ctx.currentTime + startAt
        gain.gain.setValueAtTime(0.0001, now)
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), now + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(now)
        osc.stop(now + duration + 0.05)
      } catch {
        // A silent page is acceptable; audio is a garnish.
      }
    }

    /** The "complete" sound: ding–dong (two descending notes). */
    function playComplete(volume) {
      const ctx = ensureAudio()
      if (!ctx) return
      tone(ctx, 660, 0, 0.16, volume)
      tone(ctx, 440, 0.18, 0.34, volume)
    }

    /** The "pending" sound: two short identical dings. */
    function playPending(volume) {
      const ctx = ensureAudio()
      if (!ctx) return
      tone(ctx, 880, 0, 0.09, volume)
      tone(ctx, 880, 0.14, 0.09, volume)
    }

    /** Volume in linear gain from the 0..100 config. */
    function linearVolume(percent) {
      const value = Number(percent)
      if (!Number.isFinite(value)) return 0.4
      return Math.max(0, Math.min(1, value / 100)) * 0.9 + 0.1
    }

    /** Where the page currently sits: `'hidden'`, `'blurred'` or `'focused'`. */
    function windowState() {
      try {
        if (typeof document === 'undefined') return 'focused'
        if (document.visibilityState === 'hidden') return 'hidden'
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return 'blurred'
      } catch {
        // An unreadable document counts as focused: silence beats noise.
      }
      return 'focused'
    }

    /**
     * Whether a session that just started needing attention may make a sound.
     *
     * The three switches are independent reasons for the answer not being in
     * front of the person — window hidden, window blurred, another session open —
     * so any enabled reason that actually applies allows the sound. Nothing is
     * played while they are looking straight at that session in a focused window.
     */
    function soundAllowed(config, state, sessionId, mainSessionId) {
      if (state === 'hidden' && config.triggerWindowHidden !== false) return true
      if (state === 'blurred' && config.triggerWindowBlurred !== false) return true
      if (sessionId !== mainSessionId && config.triggerOtherSession !== false) return true
      return false
    }

    // ------------------------------------------------------------------
    // Configuration reading: a tiny store source over configForms.
    // ------------------------------------------------------------------

    /**
     * Wrap the configForms form for this plugin into a stable source, so the
     * floating badge and the sound logic can subscribe to live values. When the
     * form is not available yet it reports the built-in defaults.
     *
     * `formsOf` is a getter, not the service itself: the Client half creates
     * this source before `configForms` is injected, and subscribers must keep
     * hearing about later values (see {@link rebind}).
     */
    function createConfigSource(formsOf) {
      const DEFAULTS = {
        enabled: true,
        language: DEFAULT_LANGUAGE,
        soundVolume: 60,
        triggerComplete: true,
        triggerPending: true,
        triggerError: true,
        triggerWindowHidden: true,
        triggerWindowBlurred: true,
        triggerOtherSession: true,
        overlayCount: 3,
        tooltipLength: 127,
        overlayCorner: 'bottomRight',
        systemNotify: true,
        systemNotifySound: false,
        systemNotifyOnlyWhenUnfocused: true,
        clickAction: 'raise',
      }
      let form
      let off
      let cached
      const listeners = new Set()

      const pick = () => {
        try {
          return formsOf()?.get?.(CONFIG_NS)
        } catch {
          return undefined
        }
      }

      const rebind = () => {
        const next = pick()
        if (next === form) return
        off?.()
        form = next
        cached = undefined
        off = next?.subscribe?.(() => notify())
        notify()
      }

      const notify = () => {
        for (const listener of listeners) listener()
      }

      const getSnapshot = () => {
        if (form === undefined) return { value: { ...DEFAULTS }, bound: false }
        let snapshot
        try {
          snapshot = form.getSnapshot()
        } catch {
          return { value: { ...DEFAULTS }, bound: false }
        }
        if (cached !== undefined && cached.status === snapshot.status && cached.revision === snapshot.revision) {
          return cached
        }
        const value = snapshot?.value
        cached = { value: { ...DEFAULTS, ...(value && typeof value === 'object' ? value : {}) }, bound: true }
        return cached
      }

      rebind()
      try {
        formsOf()?.describe?.()?.subscribe?.(() => {
          rebind()
        })
      } catch {
        // describe() may not expose a subscription; rebind still runs on demand.
      }

      return {
        getSnapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        bound() {
          return form !== undefined
        },
        /** Re-resolve the form (called once the service becomes available). */
        refresh() {
          rebind()
        },
        /** Write several fields in one batch. */
        setMany(pairs) {
          if (!form) return Promise.resolve(undefined)
          const ops = pairs.map(([field, value]) => ({ op: 'set', path: [field], value }))
          try {
            return Promise.resolve(form.mutate(ops))
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
      }
    }

    // ------------------------------------------------------------------
    // Floating summary (shell.overlay occupant).
    // ------------------------------------------------------------------

    const CORNER_STYLE = {
      bottomRight: { bottom: 16, right: 16 },
      bottomLeft: { bottom: 16, left: 16 },
      topRight: { top: 16, right: 16 },
      topLeft: { top: 16, left: 16 },
    }

    /**
     * Wrap the workspace list into a source of archived session ids.
     *
     * Archived sessions keep their official `completionUnread` flag — only the
     * app's own code clears that — but the user has filed them away, so this
     * plugin treats them as handled and stops reminding about them.
     */
    function createArchivedSource(workspaces) {
      const list = workspaces?.list
      return {
        getSnapshot() {
          try {
            const ids = list?.getSnapshot?.()?.archivedSessionIds
            return Array.isArray(ids) && ids.length > 0 ? new Set(ids) : EMPTY_SET
          } catch {
            return EMPTY_SET
          }
        },
        subscribe(listener) {
          if (list === undefined || typeof list.subscribe !== 'function') return () => {}
          try {
            return list.subscribe(() => listener()) ?? (() => {})
          } catch {
            return () => {}
          }
        },
      }
    }

    /**
     * Wrap the session list into a source of `{ byId, current }`.
     *
     * The sidebar hides two kinds of session (see the official
     * `sessionVisible`): subagent sessions, and blank sessions that are not the
     * one on screen. Both can still carry `completionUnread`, so counting them
     * would report reminders for rows the user cannot even see.
     */
    function createSessionsSource(sessions, uiSession) {
      const list = sessions?.list
      return {
        getSnapshot() {
          try {
            const state = list?.getSnapshot?.()
            const byId = state?.byId
            if (byId === undefined || byId === null) return EMPTY_SESSION_META
            return { byId, current: currentSessionId(uiSession) }
          } catch {
            return EMPTY_SESSION_META
          }
        },
        subscribe(listener) {
          if (list === undefined || typeof list.subscribe !== 'function') return () => {}
          try {
            return list.subscribe(() => listener()) ?? (() => {})
          } catch {
            return () => {}
          }
        },
      }
    }

    /**
     * Whether the sidebar would show this session, so the plugin only reminds
     * about rows the user can actually find and open.
     *
     * An unknown session is treated as visible: it is safer to remind once too
     * often than to silently swallow a real completion.
     */
    function sessionShown(sessionId, meta, archived) {
      if (archived.has(sessionId)) return false
      const session = meta?.byId?.[sessionId]
      if (session === undefined || session === null) return true
      if (session.origin === 'subagent') return false
      if (session.blank === true && session.id !== meta.current) return false
      return true
    }

    /** A short human label for one session, or undefined when unknown. */
    function sessionTitle(sessionId, meta) {
      const session = meta?.byId?.[sessionId]
      if (session === undefined || session === null) return undefined
      for (const field of ['title', 'summary', 'name', 'preview']) {
        const value = session[field]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
      return undefined
    }

    /**
     * Rows worth reminding about, one entry per session, skipping archived ones.
     *
     * The status map is keyed by session id; the status record itself has no id
     * field, so the key is the only identity available here.
     */
    function unreadRows(statuses, archived, meta) {
      if (statuses === undefined || statuses === null) return []
      const skip = archived ?? EMPTY_SET
      const pairs = typeof statuses.entries === 'function' ? [...statuses.entries()] : Object.entries(statuses)
      const out = []
      for (const [sessionId, status] of pairs) {
        if (status === undefined || status === null) continue
        if (skip.has(sessionId)) continue
        if (!sessionShown(sessionId, meta ?? EMPTY_SESSION_META, skip)) continue
        if (status.completionUnread === true) out.push({ id: sessionId, kind: 'unread' })
        const kind = status.pendingInteraction?.kind
        if (kind === 'approval') out.push({ id: sessionId, kind: 'approval' })
        else if (kind === 'question' || kind === 'plan-review') out.push({ id: sessionId, kind: 'question' })
      }
      return out
    }

    /**
     * Subscribe to a store-like source with only the React hooks the dynamic
     * client half guarantees (useState + useEffect). `React.useSyncExternalStore`
     * is NOT available here, so we hand-roll the subscribe + re-render.
     */
    function useSource(source, getInitial) {
      const [snapshot, setSnapshot] = React.useState(getInitial)
      React.useEffect(() => {
        let alive = true
        const update = () => {
          if (!alive) return
          try {
            setSnapshot(source.getSnapshot())
          } catch {
            // Keep the previous snapshot if the source errors mid-flight.
          }
        }
        update()
        let off = () => {}
        try {
          off = source.subscribe(update) || (() => {})
        } catch {
          // A source without subscribe is a static value; update() already ran.
        }
        return () => {
          alive = false
          try {
            off()
          } catch {
            // Already disposed.
          }
        }
      }, [source])
      return snapshot
    }

    function WhaleOverlay(props) {
      const { statusSource, configSource, archivedSource, sessionsSource, onOpen } = props
      const statuses = useSource(statusSource, () => new Map())
      const config = useSource(configSource, () => ({ value: {}, bound: false }))
      const [expanded, setExpanded] = React.useState(false)

      // Opening a session is the whole point of the expanded list, so the list
      // collapses once a row has been activated.
      const activate = (sessionId) => {
        try {
          onOpen?.(sessionId)
        } catch {
          // Opening is best-effort; the row stays visible on failure.
        }
        setExpanded(false)
      }

      // Archived sessions keep their official unread flag, but the user has
      // already filed them away, so they must not keep this badge lit.
      const archived = useSource(archivedSource ?? EMPTY_ARCHIVED_SOURCE, () => EMPTY_SET)
      const meta = useSource(sessionsSource ?? EMPTY_SESSIONS_SOURCE, () => EMPTY_SESSION_META)

      const t = translatorFor(config.value.language)
      const rows = unreadRows(statuses, archived, meta)
      const count = rows.length
      const corner = CORNER_STYLE[config.value.overlayCorner] ?? CORNER_STYLE.bottomRight

      // The master switch silences the Client half too, not only the Host.
      if (config.value.enabled === false) return null
      if (count === 0) return null

      const badgeText = count > 9 ? '9+' : String(count)
      const label = `${count} ${t('overlay.unread')}`

      return h('div', {
        style: {
          position: 'fixed',
          ...corner,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: corner.right !== undefined ? 'flex-end' : 'flex-start',
          gap: 6,
          pointerEvents: 'auto',
        },
      }, h('button', {
        type: 'button',
        onClick: () => setExpanded(!expanded),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px 6px 6px',
          border: '1px solid rgba(230,46,46,0.4)',
          borderRadius: 18,
          background: 'rgba(24,26,32,0.92)',
          color: '#fff',
          cursor: 'pointer',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 13,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        },
      },
        h('span', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 20,
            height: 20,
            padding: '0 5px',
            borderRadius: 10,
            background: '#e62e2e',
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1,
          },
        }, badgeText),
        h('span', null, label),
        h('span', { style: { opacity: 0.55, fontSize: 11 } }, expanded ? '▾' : '▸'),
      ), expanded ? h('div', {
        style: {
          minWidth: 220,
          maxWidth: 320,
          padding: '6px 10px',
          borderRadius: 10,
          background: 'rgba(24,26,32,0.95)',
          color: '#fff',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        },
      }, rows.slice(0, Math.max(1, Number(config.value.overlayCount) || 3)).map((row, index) => {
        const color = row.kind === 'unread' ? '#3aa757' : '#f0b429'
        const title = sessionTitle(row.id, meta)
        return h('button', {
          key: `${row.id}-${index}`,
          type: 'button',
          title: t('overlay.open'),
          onClick: () => activate(row.id),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '4px 2px',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: 4,
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.background = 'rgba(255,255,255,0.08)'
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent'
          },
        },
          h('span', { style: { color, fontSize: 10, flex: '0 0 auto' } }, '●'),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title ?? row.id ?? '—'),
        )
      }), rows.length > Math.max(1, Number(config.value.overlayCount) || 3) ? h('div', { style: { padding: '3px 0', opacity: 0.6 } }, t('overlay.more').replace('{n}', String(rows.length - Math.max(1, Number(config.value.overlayCount) || 3)))) : null) : null)
    }

    // ------------------------------------------------------------------
    // Settings page (plugins.row.config occupant).
    // ------------------------------------------------------------------

    function RowSummary(props) {
      const config = useSource(props.configSource, () => ({ value: {}, bound: false }))
      const t = translatorFor(config.value.language)
      return h('p', { style: { margin: 0, fontSize: 13, opacity: 0.75 } }, t('settings.rowSummary'))
    }

    /**
     * The settings page body.
     *
     * Two seats render it: `plugins.row.config` hands a ConfigPageForm through
     * `props.form`, while `settings.section` hands only `{ close }` and this half
     * therefore passes the config source instead. Both are folded into one
     * `{ initial, mutate }` pair so every control below stays seat-agnostic.
     */
    const NO_VALUE_SOURCE = { getSnapshot: () => ({ value: {} }), subscribe: () => () => {} }

    function ConfigPage(props) {
      const form = props.form
      const source = form === undefined ? (props.configSource ?? NO_VALUE_SOURCE) : NO_VALUE_SOURCE
      const live = useSource(source, () => ({ value: {} }))
      // The plugin-manager's props are a snapshot taken once, so edits are
      // tracked locally: that keeps every control (and the language switch
      // itself) live. In the settings section the source is live already.
      //
      // The draft holds ONLY the fields the user has touched. Copying the whole
      // initial config in would shadow later external updates (another window
      // saving, or the form re-supplying a value) with a stale copy.
      const initial = form?.state?.value ?? live.value
      const [draft, setDraft] = React.useState(() => ({}))
      const value = { ...(initial ?? {}), ...draft }
      const t = translatorFor(value.language)

      const setField = (field, next) => {
        setDraft((previous) => ({ ...previous, [field]: next }))
        try {
          if (typeof form?.mutate === 'function') {
            // Omit the revision: configForms resolves the current one itself, so
            // several quick edits cannot collide.
            form.mutate([{ op: 'set', path: [field], value: next }])
          } else if (typeof props.configSource?.setMany === 'function') {
            props.configSource.setMany([[field, next]])
          }
        } catch {
          // A rejected write is not worth breaking the form over.
        }
      }

      const checkbox = (field, label, hint) => h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' },
      },
        h('input', {
          type: 'checkbox',
          checked: value[field] === true,
          onChange: (event) => setField(field, event.target.checked),
        }),
        h('span', null, label),
        hint ? h('span', { style: { opacity: 0.5, fontSize: 12 } }, hint) : null,
      )

      const section = (title, children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em' } }, title),
        ...children,
      )

      const testButton = () => {
        try {
          playComplete(linearVolume(Number(value.soundVolume)))
          setTimeout(() => playPending(linearVolume(Number(value.soundVolume))), 500)
        } catch {
          // Sound is best-effort.
        }
        fetch(TEST_FLASH_PATH, { method: 'POST', credentials: 'same-origin' }).catch(() => {})
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 520 } },
        section(t('settings.enabled'), [
          checkbox('enabled', t('settings.enabled'), t('settings.enabledHint')),
        ]),
        section(t('settings.language'), [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16 } },
            [['zh', '中文'], ['en', 'English']].map(([code, label]) => h('label', {
              key: code,
              style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' },
            },
              h('input', {
                type: 'radio',
                name: 'language',
                checked: (value.language ?? 'zh') === code,
                onChange: () => setField('language', code),
              }),
              h('span', null, label),
            )),
          ),
          h('div', { style: { opacity: 0.5, fontSize: 12 } }, t('settings.languageHint')),
        ]),
        section(t('settings.triggers'), [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16 } },
            checkbox('triggerComplete', t('settings.triggerComplete')),
            checkbox('triggerPending', t('settings.triggerPending')),
            checkbox('triggerError', t('settings.triggerError')),
          ),
        ]),
        section(t('settings.attention'), [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16 } },
            checkbox('triggerWindowHidden', t('settings.triggerWindowHidden')),
            checkbox('triggerWindowBlurred', t('settings.triggerWindowBlurred')),
            checkbox('triggerOtherSession', t('settings.triggerOtherSession')),
          ),
        ]),
        section(t('settings.soundVolume'), [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: Number(value.soundVolume) || 0,
              onChange: (event) => setField('soundVolume', Number(event.target.value)),
              style: { flex: 1 },
            }),
            h('span', { style: { minWidth: 34, textAlign: 'right', fontSize: 13 } }, `${Number(value.soundVolume) || 0}`),
            h('button', {
              type: 'button',
              onClick: () => playComplete(linearVolume(Number(value.soundVolume))),
              style: { padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
            }, t('settings.playTest')),
          ),
          h('div', { style: { opacity: 0.5, fontSize: 12 } }, t('settings.soundVolumeHint')),
        ]),
        section(t('settings.systemNotify'), [
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            checkbox('systemNotify', t('settings.systemNotify'), t('settings.systemNotifyHint')),
            checkbox('systemNotifySound', t('settings.systemNotifySound'), t('settings.systemNotifySoundHint')),
            checkbox('systemNotifyOnlyWhenUnfocused', t('settings.systemNotifyOnlyWhenUnfocused'), t('settings.systemNotifyOnlyWhenUnfocusedHint')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
              h('div', { style: { fontSize: 13 } }, t('settings.clickAction')),
              ['raise', 'show', 'none'].map((action) => h('label', {
                key: action,
                style: { display: 'flex', flexDirection: 'column', gap: 1, fontSize: 13, cursor: 'pointer', paddingLeft: 4 },
              },
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('input', {
                    type: 'radio',
                    name: 'clickAction',
                    checked: (value.clickAction ?? 'raise') === action,
                    onChange: () => setField('clickAction', action),
                  }),
                  h('span', null, t(`settings.click${action === 'raise' ? 'Raise' : action === 'show' ? 'Show' : 'None'}`)),
                ),
                h('div', { style: { opacity: 0.5, fontSize: 12, paddingLeft: 22 } }, t(`settings.click${action === 'raise' ? 'Raise' : action === 'show' ? 'Show' : 'None'}Hint`)),
              )),
              h('div', { style: { opacity: 0.5, fontSize: 12 } }, t('settings.clickActionHint')),
            ),
          ),
        ]),
        section(t('settings.overlayCount'), [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('input', {
              type: 'number',
              min: 1,
              max: 20,
              step: 1,
              value: Number(value.overlayCount) || 3,
              onChange: (event) => setField('overlayCount', Number(event.target.value)),
              style: { width: 64, fontSize: 13 },
            }),
            h('span', { style: { fontSize: 13 } }, t('settings.overlayCountUnit')),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
            h('span', { style: { fontSize: 13 } }, t('settings.tooltipLength')),
            h('input', {
              type: 'number',
              min: 1,
              max: 256,
              step: 1,
              value: Number(value.tooltipLength) || 127,
              onChange: (event) => setField('tooltipLength', Number(event.target.value)),
              style: { width: 64, fontSize: 13 },
            }),
          ),
        ]),
        section(t('settings.overlayCorner'), [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            ['bottomRight', 'bottomLeft', 'topRight', 'topLeft'].map((corner) => h('label', {
              key: corner,
              style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' },
            },
              h('input', {
                type: 'radio',
                name: 'overlayCorner',
                checked: (value.overlayCorner ?? 'bottomRight') === corner,
                onChange: () => setField('overlayCorner', corner),
              }),
              h('span', null, t(`corner.${corner}`)),
            )),
          ),
        ]),
        section(t('settings.testButton'), [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('button', {
              type: 'button',
              onClick: testButton,
              style: { padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
            }, t('settings.testButton')),
            h('span', { style: { opacity: 0.5, fontSize: 12 } }, t('settings.testButtonHint')),
          ),
        ]),
      )
    }

    // ------------------------------------------------------------------
    // Apply.
    // ------------------------------------------------------------------

    const inject = ['uiSession', 'slots', 'locale', 'workspaces', 'sessions']

    function apply(ctx) {
      // Register the translations once.
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'whale-reminder: locale')

      // The composer is a Lexical editor rendered as a `contenteditable` div
      // carrying `data-composer-input`; that attribute is the only stable
      // handle it exposes, so it leads the selector list and the rest are
      // fallbacks for a future markup change. Nothing here throws: a missing
      // input means the window came forward and the person clicks it, which
      // is the documented degraded behaviour rather than an error.
      const COMPOSER_SELECTORS = [
        '[data-composer-input]',
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"][aria-multiline="true"]',
      ]

      const focusComposer = () => {
        const dom = typeof document !== 'undefined' ? document : undefined
        if (dom === undefined || typeof dom.querySelector !== 'function') return false
        for (const selector of COMPOSER_SELECTORS) {
          try {
            const target = dom.querySelector(selector)
            if (target === null || target === undefined) continue
            if (typeof target.focus === 'function') {
              target.focus()
              return true
            }
          } catch {
            // A selector the browser rejects simply loses its turn.
          }
        }
        return false
      }

      // Opening a session from the badge is navigation, not selection: the
      // Workspace controller already handles history and retention. The
      // service is read optionally so a missing controller degrades to a
      // no-op click rather than an unmounted Client half.
      const openSession = (sessionId, options) => {
        if (sessionId === undefined || sessionId === null) return
        const wantFocus = options?.focus === true
        try {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (typeof uiWorkspace?.openSession !== 'function') {
            // Silent here would look exactly like a broken toast, so say it.
            ctx.logger?.warn?.(
              `cannot open ${sessionId}: uiWorkspace.openSession is unavailable`,
            )
            return
          }
          uiWorkspace.openSession(sessionId)
          // `openSession` is a no-op for a session this Workspace cannot
          // resolve, and it returns nothing, so the only way to tell a real
          // navigation from a dropped one is to look at the current session
          // afterwards. A dropped click is worth a warning: it is the
          // difference between "the toast is broken" and "that session is
          // gone", and only one of those is worth chasing.
          const confirm = typeof setTimeout === 'function' ? setTimeout : undefined
          confirm?.(() => {
            try {
              const current = ctx.uiSession?.current?.getSnapshot?.()
              const landed = current?.key ?? current?.sessionId
              if (landed !== sessionId) {
                ctx.logger?.warn?.(
                  `toast click for ${sessionId} did not navigate (now at ${String(landed)})`,
                )
                return
              }
              // Only a click that actually navigated asks for the keyboard:
              // stealing focus on a dropped navigation would interrupt the
              // person for nothing.
              if (wantFocus) focusComposer()
            } catch {
              // A snapshot read is best-effort diagnostics only.
            }
          }, 600)
        } catch (error) {
          ctx.logger?.warn?.(`failed to open session ${sessionId}: ${error?.message ?? error}`)
        }
      }

      // A Windows toast cannot call into this application: clicking it starts a
      // short-lived handler that reports the session id to the Host over
      // loopback HTTP. The Host broadcasts that click, and this poll is what
      // turns it into navigation. Polling is cheap (one small same-origin GET)
      // and only runs while the page is alive, so nothing is left behind.
      //
      // The config source is created first (with a getter) so this effect can
      // read `clickAction` before the Client injects `configForms`, and the
      // dot/sound effect can subscribe to it later.
      let forms
      const configSource = createConfigSource(() => forms)
      ctx.effect(() => {
        let stopped = false
        let timer
        let seen
        // A freshly loaded window must not replay a click that was already
        // handled elsewhere (or one that is merely still inside its TTL): the
        // first successful poll only adopts the current sequence number.

        const poll = () => {
          if (stopped) return
          fetch(ACTIVATE_PATH, { credentials: 'same-origin', cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((payload) => {
              if (payload === undefined) return
              const seq = Number(payload?.seq)
              if (!Number.isFinite(seq)) return
              const previous = seen
              seen = seq
              // First poll after load only adopts the baseline.
              if (previous === undefined) return
              // The Host broadcasts each click to every window, so a half only
              // acts on a sequence it has not seen yet. Without this a click
              // would be replayed on every poll until it expired.
              if (seq <= previous) return
              const sessionId = payload?.sessionId
              if (typeof sessionId !== 'string' || sessionId.length === 0) return
              // The handler raised the window before reporting, so by now this
              // page has the keyboard. Whether it also moves the caret into the
              // composer is the person's call, read live so a toggle applies to
              // the very next click.
              openSession(sessionId, { focus: configSource.getSnapshot().value.clickAction === 'raise' })
            })
            .catch(() => {
              // The Host may not be serving the route yet (or at all on a
              // platform without toasts); a missed poll is not an error.
            })
        }

        const schedule = () => {
          if (stopped) return
          if (timer !== undefined) clearInterval(timer)
          // Faster while the window is behind something else, because that is
          // exactly when a toast gets clicked; slower when it is in front.
          const interval = windowState() === 'focused' ? ACTIVATE_POLL_FOCUSED_MS : ACTIVATE_POLL_BACKGROUND_MS
          timer = setInterval(poll, interval)
          if (typeof timer?.unref === 'function') timer.unref()
        }

        // A backgrounded Chromium renderer throttles timers hard (often to once
        // a minute), so a click can sit in the Host long after the person
        // clicked. Polling immediately on the events that accompany a window
        // being raised is what makes the click land right away.
        const wake = () => {
          schedule()
          poll()
        }

        schedule()
        const onVisibility = () => wake()
        // `typeof` rather than optional chaining: an undeclared `document`
        // throws, and a test host has no DOM at all.
        const dom = typeof document !== 'undefined' ? document : undefined
        const view = typeof window !== 'undefined' ? window : undefined
        try {
          dom?.addEventListener?.('visibilitychange', onVisibility)
          view?.addEventListener?.('focus', onVisibility)
          view?.addEventListener?.('blur', onVisibility)
        } catch {
          // A non-DOM host simply keeps the current cadence.
        }

        return () => {
          stopped = true
          if (timer !== undefined) clearInterval(timer)
          timer = undefined
          try {
            dom?.removeEventListener?.('visibilitychange', onVisibility)
            view?.removeEventListener?.('focus', onVisibility)
            view?.removeEventListener?.('blur', onVisibility)
          } catch {
            // Same as above.
          }
        }
      }, 'whale-reminder: toast click poll')

      let statusSource = { getSnapshot: () => new Map(), subscribe: () => () => {} }
      const archivedSource = createArchivedSource(ctx.workspaces)
      const sessionsSource = createSessionsSource(ctx.sessions, ctx.uiSession)

      ctx.effect(() => {
        const source = ctx.uiSession?.sessionStatus
        if (source === undefined || typeof source.subscribe !== 'function') {
          console.warn('[whale-reminder] uiSession.sessionStatus is unavailable; the Host keeps its focus fallback')
          return () => {}
        }
        statusSource = source

        // Identity of the sessions already accounted for, per sound kind. Sets
        // rather than counts: a sound must fire for a *newly* affected session,
        // and the window policy below has to be judged per session.
        let lastIds = { unread: new Set(), pending: new Set() }
        let primed = false
        let lastTotal
        let lastMain
        let pending
        let heartbeat

        const flush = (force = false) => {
          pending = undefined
          const statuses = source.getSnapshot()
          const archived = archivedSource.getSnapshot()
          const meta = sessionsSource.getSnapshot()
          const main = currentSessionId(ctx.uiSession)

          // A disabled plugin reports nothing, which also tells the Host to stop
          // any flash it already started.
          const config = configSource.getSnapshot().value
          const disabled = config.enabled === false
          const counted = disabled
            ? { approval: 0, question: 0, unread: 0, total: 0 }
            : countDots(statuses, archived, meta)

          // Sound: only for sessions that newly need attention, so a dot that
          // merely persists does not replay the sound on every heartbeat.
          const rows = disabled ? [] : unreadRows(statuses, archived, meta)
          const unreadIds = new Set(rows.filter((row) => row.kind === 'unread').map((row) => row.id))
          const pendingIds = new Set(rows.filter((row) => row.kind !== 'unread').map((row) => row.id))
          if (primed && !disabled) {
            const state = windowState()
            const addedUnread = [...unreadIds].filter((id) => !lastIds.unread.has(id))
            const addedPending = [...pendingIds].filter((id) => !lastIds.pending.has(id))
            if (addedUnread.some((id) => soundAllowed(config, state, id, main)) && config.triggerComplete !== false) {
              playComplete(linearVolume(config.soundVolume))
            }
            if (addedPending.some((id) => soundAllowed(config, state, id, main)) && config.triggerPending !== false) {
              playPending(linearVolume(config.soundVolume))
            }
          }
          primed = true
          lastIds = { unread: unreadIds, pending: pendingIds }

          if (!force && counted.total === lastTotal && main === lastMain) return
          lastTotal = counted.total
          lastMain = main
          report({
            counts: { approval: counted.approval, question: counted.question, unread: counted.unread },
            mainSessionId: main ?? null,
          })
        }

        const schedule = () => {
          if (pending !== undefined) return
          pending = setTimeout(flush, THROTTLE_MS)
        }

        const disposers = [source.subscribe(schedule)]
        const currentSource = ctx.uiSession?.current
        if (currentSource !== undefined && typeof currentSource.subscribe === 'function') {
          disposers.push(currentSource.subscribe(schedule))
        }
        // Archiving a session must drop it from the count immediately.
        disposers.push(archivedSource.subscribe(schedule))
        disposers.push(sessionsSource.subscribe(schedule))
        // So must flipping the master switch: otherwise the badge and the Host
        // flash would linger until the next heartbeat.
        disposers.push(configSource.subscribe(schedule))

        flush()
        heartbeat = setInterval(() => flush(true), HEARTBEAT_MS)
        if (typeof heartbeat?.unref === 'function') heartbeat.unref()

        return () => {
          if (pending !== undefined) clearTimeout(pending)
          pending = undefined
          if (heartbeat !== undefined) clearInterval(heartbeat)
          heartbeat = undefined
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // A disposed store is not an error worth surfacing.
            }
          }
          clearOnUnload()
        }
      }, 'whale-reminder: dot reports + sound')

      // Config source over configForms, plus the settings page registration.
      ctx.inject(['configForms'], (scope) => {
        forms = scope.get('configForms')
        if (!forms) return
        // Picking up the service is what activates the source for the effects
        // registered above.
        configSource.refresh()

        scope.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_CONFIG_KEY,
          locale: NS,
        }, (props) => props.view === 'summary'
          ? h(RowSummary, { configSource })
          : h(ConfigPage, { form: props.form }))), 'whale-reminder: settings page')

        // Same page body, second seat: Settings → sidebar entry. A person who
        // wants to turn the reminders down goes to Settings, not to the plugin
        // manager, so the page has to be reachable there too.
        //
        // The label is a thunk, which the slot re-reads on every projection, so
        // switching language renames the entry without re-registering it.
        scope.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          // Sits with the other notification-ish entries, before the very
          // opinionated ones that ship at 100.
          order: 50,
          label: () => translatorFor(configSource.getSnapshot().value.language)('settings.sectionLabel'),
          locale: NS,
          inject: () => ({ configSource }),
        }, (props) => h(ConfigPage, {
          configSource: props.configSource ?? configSource,
        }))), 'whale-reminder: settings section')
      })

      // Floating summary.
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-whale-reminder:overlay',
        order: 110,
        locale: NS,
        inject: () => ({
          statusSource,
          configSource,
          archivedSource,
          sessionsSource,
          openSession,
        }),
      }, (props) => h(WhaleOverlay, {
        statusSource: props.statusSource ?? statusSource,
        configSource: props.configSource ?? configSource,
        archivedSource: props.archivedSource ?? archivedSource,
        sessionsSource: props.sessionsSource ?? sessionsSource,
        onOpen: props.openSession ?? openSession,
      }))), 'whale-reminder: floating badge')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
