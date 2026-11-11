/**
 * Locate `@deepseek-ai/schemastery` from inside a Host plugin.
 *
 * The Config schema in `index.js` needs a Schema constructor at module load time,
 * but a `link:`/`file:`-installed plugin lives outside the profile directory, so
 * its own `node_modules` may not exist and a static `import z from ...` walks up
 * the workspace path and fails with ERR_MODULE_NOT_FOUND — verified against the
 * real desktop profile (schemastery 3.18.5 sits in the profile root, not beside
 * the plugin source).
 *
 * This loader mirrors `koffi-loader.mjs`: try the normal bare require first
 * (npm/repository installs), then the two anchors that always exist when the Host
 * runs — the application asar (which ships schemastery as a dependency of
 * `@deepseek-ai/dsh`) and the profile root (which carries it as a peer of
 * `@deepseek-ai/dsh-settings`). Loading is synchronous because the Config schema
 * is built at module top level.
 *
 * A total failure throws: unlike koffi, the schema cannot be optional, because
 * the settings service reads `runtime.Config` to address this plugin's form.
 *
 * @module dsh-whale-reminder/schemastery-loader
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Build the ordered list of places to resolve `@deepseek-ai/schemastery` from.
 *
 * @param environment - process facts to derive candidates from.
 * @returns candidate descriptors, most reliable first.
 */
export function schemasteryCandidates(environment = {}) {
  const {
    resourcesPath = process.resourcesPath,
    execPath = process.execPath,
    profileDir = process.env.DSH_PROFILE_DIR,
  } = environment

  /** @type {{ label: string, specifier: string, anchor?: string }[]} */
  const candidates = []

  // Normal path: declared dependency, resolved beside this file.
  candidates.push({ label: 'plugin', specifier: '@deepseek-ai/schemastery' })

  // The Host always runs inside the application asar, where schemastery ships.
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push({
      label: 'app.asar',
      specifier: join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'),
    })
  }
  if (typeof execPath === 'string' && execPath.length > 0) {
    candidates.push({
      label: 'exec-dir',
      specifier: join(execPath, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'),
    })
  }

  // The profile root carries schemastery as a peer of dsh-settings.
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    candidates.push({ label: 'profile', specifier: '@deepseek-ai/schemastery', anchor: join(profileDir, 'package.json') })
  }

  return candidates
}

/**
 * Resolve and load the Schema constructor.
 *
 * @param options - overrides for the derivation inputs plus an injectable `require`.
 * @returns the schemastery default export (the `Schema` function).
 * @throws when every candidate failed.
 */
export function loadSchemastery(options = {}) {
  const { requireModule, candidates, onMiss } = options
  const list = candidates ?? schemasteryCandidates(options)
  const failures = []

  for (const candidate of list) {
    try {
      const loaded = requireModule === undefined
        ? resolveWith(candidate)
        : requireModule(candidate)
      if (loaded !== undefined && loaded !== null) {
        return loaded
      }
      failures.push(`${candidate.label}: empty`)
    } catch (error) {
      failures.push(`${candidate.label}: ${describe(error)}`)
    }
  }

  if (onMiss !== undefined) onMiss(failures)
  const error = new Error(`unable to load @deepseek-ai/schemastery: ${failures.join(' | ')}`)
  error.name = 'ERR_SCHEMASTERY_NOT_FOUND'
  throw error
}

/**
 * Resolve one candidate through `createRequire`, honouring its anchor.
 *
 * @param candidate - label, specifier, and optional anchor path.
 * @returns the loaded module.
 */
function resolveWith(candidate) {
  const anchor = candidate.anchor ?? import.meta.url
  return createRequire(anchor)(candidate.specifier)
}

/**
 * Reduce an error to one short line for the failure log.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}
