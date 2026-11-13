/**
 * Windows system notifications (toast) for the Host half.
 *
 * The Host runs as a plain Node child process of the Electron main process, so
 * Electron's `Notification` class is out of reach. What is reachable is WinRT:
 * `Windows.UI.Notifications.ToastNotificationManager` can raise a real Windows
 * toast, and it needs only two things — an AppUserModelID that Windows will use
 * as the notification source, and a small XML payload.
 *
 * The AUMID is registered under `HKCU\Software\Classes\AppUserModelId\<id>` with
 * a `DisplayName` and an `IconUri`. That registration is what makes the toast
 * appear in Settings → System → Notifications as its own row with its own
 * banner/sound switches, instead of borrowing the host application's identity.
 *
 * PowerShell is the only bridge to WinRT from plain Node, so each toast spawns
 * one short-lived `powershell.exe`. Measured cost is roughly 220–280 ms of
 * process startup, which is fine for an event that fires once per finished turn
 * — and it is spawned asynchronously so the Host's event loop never blocks.
 *
 * Everything the script needs is passed as one base64 JSON blob inside an
 * `-EncodedCommand` script. That keeps the whole invocation pure ASCII: Windows
 * PowerShell mis-parses non-ASCII text and quotes passed on the command line,
 * and an `XmlDocument.LoadXml` failure surfaces only as the opaque
 * `0xC00CE56D`. Round-tripping through base64 also means a session title
 * containing `<`, `"` or an emoji cannot break the payload.
 *
 * @module dsh-whale-reminder/toast
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * AppUserModelID this plugin registers for itself.
 *
 * Stable across versions on purpose: Windows keys the per-app notification
 * switches and the notification history on this string, so renaming it would
 * silently reset the person's choices.
 */
export const AUMID = 'Shawn.DSHWhaleReminder'

/** How long one `powershell.exe` may live before it is killed. */
const SCRIPT_TIMEOUT_MS = 10_000

/** Characters XML 1.0 forbids outright; a stray NUL makes `LoadXml` throw. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/**
 * Escape text for inclusion in XML character data.
 *
 * @param text - raw text, possibly containing markup characters.
 * @returns the escaped text.
 */
function escapeXml(text) {
  return String(text)
    .replace(ILLEGAL_XML, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build the ToastGeneric payload.
 *
 * Two text lines only: the first states what happened, the second names the
 * session. One line of detail is what makes a notification actionable; a third
 * line of prose is what makes people turn notifications off.
 *
 * @param request - resolved toast content.
 * @returns the XML string handed to `XmlDocument.LoadXml`.
 */
function buildXml(request) {
  const icon = request.iconPath !== undefined && existsSync(request.iconPath)
    ? pathToFileURL(request.iconPath).href
    : undefined

  // A click on the toast must land back in this application on the right
  // session. Windows raises the registered protocol handler for a
  // `activationType="protocol"` toast, so the launch URI carries the session id
  // and the Host turns it into navigation. Without a launch target the toast
  // only brings the window forward, which is what made the badge feel inert.
  const activation = typeof request.launch === 'string' && request.launch.length > 0
    ? 'activationType="protocol" launch="' + escapeXml(request.launch) + '"'
    : 'activationType="foreground"'

  const parts = [
    `<toast ${activation}>`,
    '<visual><binding template="ToastGeneric">',
    `<text>${escapeXml(request.headline)}</text>`,
  ]
  if (typeof request.detail === 'string' && request.detail.length > 0) {
    parts.push(`<text>${escapeXml(request.detail)}</text>`)
  }
  if (icon !== undefined) {
    parts.push(`<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(icon)}"/>`)
  }
  parts.push('</binding></visual>')
  if (request.silent === true) parts.push('<audio silent="true"/>')
  parts.push('</toast>')
  return parts.join('')
}

/**
 * Build the PowerShell program that registers the identity and raises one toast.
 *
 * @param payload - ASCII-safe fields plus the base64 JSON envelope.
 * @returns the script text, always ASCII.
 */
function buildScript(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$raw = [System.Convert]::FromBase64String('${encoded}')`,
    '$json = [System.Text.Encoding]::UTF8.GetString($raw)',
    '$p = $json | ConvertFrom-Json',
    // Registering on every send is idempotent and costs microseconds; it also
    // repairs the key if something removed it while the app was running.
    "$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $p.aumid",
    'New-Item -Path $key -Force | Out-Null',
    "New-ItemProperty -Path $key -Name 'DisplayName' -Value $p.displayName -PropertyType String -Force | Out-Null",
    "if ($p.iconPath -ne '') { New-ItemProperty -Path $key -Name 'IconUri' -Value $p.iconPath -PropertyType String -Force | Out-Null }",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($p.xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($p.aumid).Show($toast)',
    "Write-Output 'OK'",
  ].join('\n')
}

/**
 * Build a sender that raises Windows toasts for this plugin.
 *
 * The sender never throws and never rejects: a notification is a courtesy, and
 * a courtesy that can break a turn is a bug.
 *
 * @param dependencies - icon path, logger and an injectable spawn for tests.
 * @returns an object with `supported` and `show`.
 */
export function createToastSender(dependencies) {
  const { iconPath, logger, spawnFn = spawn, platform = process.platform, displayName } = dependencies
  const supported = platform === 'win32'
  let warned = false

  /**
   * Log a backend failure once: a permanently missing WinRT stack would
   * otherwise write a warning on every finished turn.
   *
   * @param message - what went wrong.
   */
  function warnOnce(message) {
    if (warned) return
    warned = true
    logger?.warn?.(`whale-reminder: system notification unavailable: ${message}`)
  }

  /**
   * Raise one toast.
   *
   * @param request - `{ headline, detail, silent }`.
   * @returns a small result describing what was attempted.
   */
  function show(request) {
    if (!supported) return { sent: false, reason: 'unsupported-platform' }
    if (request === undefined || request === null) return { sent: false, reason: 'empty' }
    const headline = typeof request.headline === 'string' ? request.headline.trim() : ''
    if (headline.length === 0) return { sent: false, reason: 'empty' }

    const xml = buildXml({
      headline,
      detail: request.detail,
      silent: request.silent === true,
      iconPath,
      launch: request.launch,
    })
    const script = buildScript({
      aumid: AUMID,
      displayName: displayName ?? 'Whale Reminder',
      iconPath: typeof iconPath === 'string' ? iconPath : '',
      xml,
    })

    let child
    try {
      child = spawnFn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      warnOnce(String(error?.message ?? error))
      return { sent: false, reason: 'spawn-failed' }
    }

    let stderr = ''
    child?.stderr?.on?.('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk)
    })
    child?.on?.('error', (error) => warnOnce(String(error?.message ?? error)))
    child?.on?.('exit', (code) => {
      if (code !== 0) warnOnce(`powershell exited ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n')[0]}`}`)
    })
    // A hung PowerShell must not accumulate: kill it rather than leak a process.
    if (typeof child?.unref === 'function') {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
      }, SCRIPT_TIMEOUT_MS)
      if (typeof timer?.unref === 'function') timer.unref()
    }

    return { sent: true }
  }

  return { supported, show }
}
