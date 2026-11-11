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
        completeSound: '完成音效',
        completeSoundHint: '一轮正常结束时播放「叮—咚」',
        pendingSound: '待回答音效',
        pendingSoundHint: '模型在等你回答时播放两声短促「叮叮」',
        playTest: '试听',
        triggerWindowHidden: '窗口被隐藏时提醒',
        triggerWindowBlurred: '窗口失焦时提醒',
        triggerOtherSession: '焦点在别的会话时提醒',
        triggerComplete: '正常完成',
        triggerPending: '待回答',
        triggerError: '出错',
        overlayCount: '浮层显示会话数',
        tooltipLength: 'tooltip 字数上限',
        overlayCorner: '浮层停靠角落',
        testButton: '测试提醒',
        testButtonHint: '一键演练：闪任务栏 + 闪托盘 + 出声 + 浮层出现',
        rowSummary: '会话结束提醒：声音 + 浮层 + 任务栏/托盘闪烁',
        language: '语言',
        languageHint: '仅影响本插件的声音提示、浮层与设置页',
        triggers: '提醒哪些事件',
        attention: '什么时候算「需要提醒」',
        soundsOverlay: '声音与浮层',
      },
      overlay: {
        unread: '个会话未读',
        latest: '最新',
        more: '还有 {n} 个未读',
        expand: '展开',
        clear: '清除',
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
        completeSound: 'Complete sound',
        completeSoundHint: 'Plays ding-dong when a turn completes',
        pendingSound: 'Pending sound',
        pendingSoundHint: 'Plays two short dings when the model awaits your answer',
        playTest: 'Preview',
        triggerWindowHidden: 'Remind when window hidden',
        triggerWindowBlurred: 'Remind when window blurred',
        triggerOtherSession: 'Remind when focus is on another session',
        triggerComplete: 'Completed',
        triggerPending: 'Awaiting answer',
        triggerError: 'Error',
        overlayCount: 'Sessions shown in overlay',
        tooltipLength: 'Tooltip char limit',
        overlayCorner: 'Overlay corner',
        testButton: 'Test reminder',
        testButtonHint: 'Run the full rehearsal: taskbar flash, tray flash, sound, overlay',
        rowSummary: 'Session-finish reminders: sound, floating badge, taskbar/tray flash',
        language: 'Language',
        languageHint: "Affects only this plugin's sound cues, overlay and settings page",
        triggers: 'Which events to remind about',
        attention: 'What counts as needing attention',
        soundsOverlay: 'Sound and overlay',
      },
      overlay: {
        unread: 'unread sessions',
        latest: 'latest',
        more: '{n} more unread',
        expand: 'Expand',
        clear: 'Clear',
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
        fetch(DOTS_PATH, { method: 'DELETE', credentials: 'same-origin', keepalive: true })
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

    // ------------------------------------------------------------------
    // Configuration reading: a tiny store source over configForms.
    // ------------------------------------------------------------------

    /**
     * Wrap the configForms form for this plugin into a stable source, so the
     * floating badge and the sound logic can subscribe to live values. When the
     * form is not available yet it reports the built-in defaults.
     */
    function createConfigSource(forms) {
      const DEFAULTS = {
        language: DEFAULT_LANGUAGE,
        soundVolume: 60,
        completeSound: '',
        pendingSound: '',
        triggerComplete: true,
        triggerPending: true,
        triggerError: true,
        triggerWindowHidden: true,
        triggerWindowBlurred: true,
        triggerOtherSession: true,
        overlayCount: 3,
        tooltipLength: 127,
        overlayCorner: 'bottomRight',
      }
      let form
      let off
      let cached
      const listeners = new Set()

      const pick = () => {
        try {
          return forms?.get?.(CONFIG_NS)
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
        forms?.describe?.()?.subscribe?.(() => {
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
      const { statusSource, configSource, archivedSource, sessionsSource } = props
      const statuses = useSource(statusSource, () => new Map())
      const config = useSource(configSource, () => ({ value: {}, bound: false }))
      const [expanded, setExpanded] = React.useState(false)

      // Archived sessions keep their official unread flag, but the user has
      // already filed them away, so they must not keep this badge lit.
      const archived = useSource(archivedSource ?? EMPTY_ARCHIVED_SOURCE, () => EMPTY_SET)
      const meta = useSource(sessionsSource ?? EMPTY_SESSIONS_SOURCE, () => EMPTY_SESSION_META)

      const t = translatorFor(config.value.language)
      const rows = unreadRows(statuses, archived, meta)
      const count = rows.length
      const corner = CORNER_STYLE[config.value.overlayCorner] ?? CORNER_STYLE.bottomRight

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
        return h('div', { key: `${row.id}-${index}`, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: 'none' } },
          h('span', { style: { color, fontSize: 10 } }, '●'),
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

    function ConfigPage(props) {
      const form = props.form
      // The plugin-manager hands a ConfigPageForm when view === 'page'. Its
      // props are a snapshot taken once, so edits are tracked locally: that
      // keeps every control (and the language switch itself) live.
      const initial = form?.state?.value
      const [draft, setDraft] = React.useState(() => ({ ...(initial ?? {}) }))
      const value = { ...(initial ?? {}), ...draft }
      const mutate = form?.mutate
      const t = translatorFor(value.language)

      const setField = (field, next) => {
        setDraft((previous) => ({ ...previous, [field]: next }))
        if (typeof mutate !== 'function') return
        try {
          // Omit the revision: configForms resolves the current one itself, so
          // several quick edits cannot collide.
          mutate([{ op: 'set', path: [field], value: next }])
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
            h('span', { style: { fontSize: 13 } }, t('settings.tooltipLength')),
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

      // The config source is shared by the sound logic and the floating badge.
      let configSource = { getSnapshot: () => ({ value: {}, bound: false }), subscribe: () => () => {}, bound: () => false, setMany: () => Promise.resolve(undefined) }
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

        let lastCounts = { approval: 0, question: 0, unread: 0 }
        let lastTotal
        let lastMain
        let pending
        let heartbeat

        const flush = (force = false) => {
          pending = undefined
          const counted = countDots(source.getSnapshot(), archivedSource.getSnapshot(), sessionsSource.getSnapshot())
          const main = currentSessionId(ctx.uiSession)

          // Sound: only on an *increase* of the relevant kind, so a dot that
          // merely persists does not replay the sound every heartbeat.
          const config = configSource.getSnapshot().value
          const unreadDelta = counted.unread - lastCounts.unread
          const pendingDelta = (counted.approval + counted.question) - (lastCounts.approval + lastCounts.question)
          if (unreadDelta > 0 && config.triggerComplete !== false) {
            playComplete(linearVolume(config.soundVolume))
          }
          if (pendingDelta > 0 && config.triggerPending !== false) {
            playPending(linearVolume(config.soundVolume))
          }
          lastCounts = { approval: counted.approval, question: counted.question, unread: counted.unread }

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
        const forms = scope.get('configForms')
        if (!forms) return
        configSource = createConfigSource(forms)

        scope.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_CONFIG_KEY,
          locale: NS,
        }, (props) => props.view === 'summary'
          ? h(RowSummary, { configSource })
          : h(ConfigPage, { form: props.form }))), 'whale-reminder: settings page')
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
        }),
      }, (props) => h(WhaleOverlay, {
        statusSource: props.statusSource ?? statusSource,
        configSource: props.configSource ?? configSource,
        archivedSource: props.archivedSource ?? archivedSource,
        sessionsSource: props.sessionsSource ?? sessionsSource,
      }))), 'whale-reminder: floating badge')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
