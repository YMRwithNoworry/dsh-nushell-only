/**
 * Nushell executable resolution, argv assembly, and the runtime facts the
 * teaching layer reads back.
 *
 * Every shell command in this deployment is evaluated by Nushell as one
 * non-interactive, configuration-isolated process:
 *
 * ```text
 * nu --no-config-file -c "<command>"
 * ```
 *
 * `--no-config-file` keeps the user's `config.nu`/`env.nu` from changing what a
 * tool call does, so commands are deterministic across machines — the same
 * contract the first-party executors give `bash -c` and `pwsh -Command`.
 *
 * @module dsh-nushell-only/nu
 */

/** The default argv prefix every command runs behind (the command is appended last). */
export const DEFAULT_NU_ARGS = ['--no-config-file', '-c']

/**
 * Runtime facts discovered by the executor at boot. The teaching layer imports
 * this same module instance, so a prompt section can name the exact Nushell
 * version and executable without a second probe.
 */
export const nuRuntime = {
  /** The executable name or path the executor spawns. */
  path: undefined,
  /** Resolved absolute executable path, when `ctx.subprocess` could resolve it. */
  resolvedPath: undefined,
  /** `nu --version` output parsed to `x.y.z`, when the probe succeeded. */
  version: undefined,
  /** How `path` was selected: `config`, `DSH_NU_PATH`, or `default`. */
  source: undefined,
  /** Why the probe failed, when it did. */
  error: undefined,
}

/**
 * Resolve the Nushell executable: an explicit `nuPath` config value, else the
 * `DSH_NU_PATH` environment variable, else bare `nu` for PATH resolution.
 * @param configured - the composition's `nuPath`, when set.
 * @param env - environment to read `DSH_NU_PATH` from.
 * @returns the executable name or path to spawn.
 */
export function resolveNuPath(configured, env = process.env) {
  const fromConfig = typeof configured === 'string' ? configured.trim() : ''
  if (fromConfig.length > 0) return { path: fromConfig, source: 'config' }
  const fromEnv = typeof env?.DSH_NU_PATH === 'string' ? env.DSH_NU_PATH.trim() : ''
  if (fromEnv.length > 0) return { path: fromEnv, source: 'DSH_NU_PATH' }
  return { path: 'nu', source: 'default' }
}

/**
 * Validate and normalize the Nu argv prefix. The command travels as the final
 * argument, so the prefix must not already contain a command placeholder.
 * @param raw - the `nuArgs` config value, when set.
 * @returns a fresh argv prefix ending at the `-c`-equivalent flag.
 * @throws Error when the value is not a non-empty array of strings.
 */
export function normalizeNuArgs(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_NU_ARGS]
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error('dsh-nushell-only: nuArgs must be a non-empty array of strings')
  }
  return [...raw]
}

/**
 * Build the exact argv one command runs as.
 * @param command - the Nushell source the caller supplied.
 * @param options - the resolved executable and argv prefix.
 * @returns the complete argv handed to `ctx.subprocess`.
 */
export function nushellArgv(command, options = {}) {
  const prefix = options.nuArgs === undefined ? [...DEFAULT_NU_ARGS] : normalizeNuArgs(options.nuArgs)
  const path = options.nuPath ?? 'nu'
  return [path, ...prefix, command]
}

/**
 * Parse `nu --version` output (`nu 0.115.1`, `0.115.1`, or a build suffix).
 * @param text - captured stdout of `nu --version`.
 * @returns the `x.y.z` version, or undefined when the text has no version.
 */
export function parseNuVersion(text) {
  if (typeof text !== 'string') return undefined
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`
}
