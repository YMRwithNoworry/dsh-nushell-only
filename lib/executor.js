/**
 * The Nushell shell executor: the single `ctx.shell` provider of a Nu-only
 * deployment.
 *
 * It reuses dsh's own sandbox-consuming executor for the machinery that must not
 * drift — request defaulting and caps, deadline fusion, cause classification,
 * output capture and spill, background handles, and the sandbox wrap plus its
 * denial/runner-failure facts — and changes exactly one thing: the argv a
 * command runs as. Instead of `bash -c <command>` / `pwsh -Command <command>`,
 * every command runs as `nu --no-config-file -c <command>`.
 *
 * Two platform seams are overridden, because the two first-party families expose
 * different ones:
 *
 * - Windows composes `@deepseek-ai/dsh-pwsh-sandbox`, whose `PwshLocalExecutor`
 *   exposes `argv(spec)` and whose confining sibling wraps `this.argv(spec)`.
 *   Overriding `argv` therefore covers both the confined and the
 *   `danger-full-access` paths.
 * - POSIX composes `@deepseek-ai/dsh-bash-sandbox`, whose `LocalBashExecutor`
 *   hardcodes `["bash", "-c", spec.command]`. There, `confine(command, policy)`
 *   is overridden (the confining path) and `run`/`start` redirect the
 *   `danger-full-access` branch to the Nu argv.
 *
 * Both overrides are written platform-agnostically: the class works whichever
 * base it resolved, and `run`/`start` produce identical results on both.
 *
 * The state this class adds lives in plain instance properties, not `#private`
 * fields: cordis hands the service out through a proxy, and a private-field
 * access on that receiver throws.
 *
 * @module dsh-nushell-only/executor
 */

import { Service } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { assertNushellOnly, compileForeignShellAllowlist } from './guard.js'
import { normalizeNuArgs, nuRuntime, nushellArgv, parseNuVersion, resolveNuPath } from './nu.js'

/**
 * The platform's sandbox-consuming first-party executor. Both families are
 * installed with `dsh-base`; the platform picks which of them a default
 * deployment mounts, and this plugin preserves that choice's mechanics.
 */
const BaseExecutor = process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor

/** Plugin name used by loader diagnostics. */
export const name = 'dsh-nushell-only'

/** Service dependencies: the subprocess seam, the sandbox provider, and the policy resolver. */
export const inject = [...BaseExecutor.inject]

/** Whether a resolved spec runs without confinement (the path a base shell hardcodes). */
function isUnconfined(executor, spec) {
  const policy = spec.sandboxPolicy ?? executor.ctx.sandboxPolicy?.resolve?.()
  return policy === undefined || policy.mode === 'danger-full-access'
}

/** Log one line through the composition's logger, tolerating a logger-less context. */
function log(executor, level, message) {
  try {
    executor.ctx.logger[level](`dsh-nushell-only: ${message}`)
  } catch {
    // Logging is best-effort; the executor works without a logger.
  }
}

/**
 * A Nushell-backed `ctx.shell` provider. Configuration:
 *
 * | Field | Default | Meaning |
 * |---|---|---|
 * | `nuPath` | `$DSH_NU_PATH`, else `nu` | Nushell executable. |
 * | `nuArgs` | `['--no-config-file', '-c']` | Argv prefix; the command is appended last. |
 * | `enforceNushellOnly` | `true` | Refuse commands that hand off to another shell. |
 * | `foreignShellAllowlist` | `[]` | Whole-command regexes exempt from the guard. |
 * | `requireNu` | `true` | Fail boot when `nu` cannot be resolved. |
 * | `verifyNu` | `true` | Run `nu --version` once at boot. |
 * | `verifyTimeoutMs` | `10000` | Bound for that probe. |
 *
 * The inherited `bash-sandbox`/`pwsh-sandbox` budgets (`cwd`, `timeoutMs`,
 * `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`) apply unchanged
 * and stay layered with the `shell` settings section.
 */
export class NushellExecutor extends BaseExecutor {
  /** Service dependencies (re-stated so the plugin's own row is self-describing). */
  static inject = [...BaseExecutor.inject]

  /** The inherited sandbox executor config schema; extra Nu keys pass through schemastery. */
  static Config = BaseExecutor.Config

  /**
   * @param ctx - the plugin context.
   * @param config - the composition entry's config, validated by the inherited schema.
   */
  constructor(ctx, config = {}) {
    const source = config ?? {}
    const executable = resolveNuPath(source.nuPath)
    const options = {
      executable: executable.path,
      source: executable.source,
      args: normalizeNuArgs(source.nuArgs),
      allow: compileForeignShellAllowlist(source.foreignShellAllowlist),
      enforce: source.enforceNushellOnly !== false,
      requireNu: source.requireNu !== false,
      verifyNu: source.verifyNu !== false,
      verifyTimeoutMs: Number.isFinite(source.verifyTimeoutMs) && source.verifyTimeoutMs > 0 ? source.verifyTimeoutMs : 10000,
      resolvedPath: undefined,
    }
    super(ctx, source)
    this.nuOptions = options
    nuRuntime.path = executable.path
    nuRuntime.source = executable.source
  }

  /**
   * Resolve `nu` and (optionally) prove it runs before the first tool call. A
   * Nu-only deployment whose `nu` is missing should say so at boot, with the
   * three ways to fix it, instead of failing every command mid-session.
   */
  async [Service.init]() {
    const options = this.nuOptions
    const subprocess = this.ctx.subprocess
    let resolvedPath
    try {
      resolvedPath = typeof subprocess?.resolveExecutable === 'function'
        ? await subprocess.resolveExecutable(options.executable)
        : options.executable
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      nuRuntime.error = detail
      if (options.requireNu) {
        throw new Error(
          `dsh-nushell-only: cannot resolve the Nushell executable ${JSON.stringify(options.executable)} (${detail}). `
          + 'Install Nushell, put `nu` on PATH, or set `nuPath` / `DSH_NU_PATH`; '
          + 'set executor config `requireNu: false` to boot anyway.',
        )
      }
      log(this, 'warn', `Nushell executable ${JSON.stringify(options.executable)} not resolved (${detail}); shell commands will fail until it is available`)
      return
    }
    options.resolvedPath = resolvedPath
    nuRuntime.resolvedPath = resolvedPath
    if (!options.verifyNu) {
      log(this, 'info', `shell executor bound to Nushell at ${resolvedPath}`)
      return
    }
    try {
      const version = await this.probeVersion(resolvedPath)
      nuRuntime.version = version
      log(this, 'info', version === undefined
        ? `shell executor bound to Nushell at ${resolvedPath} (version not reported)`
        : `shell executor bound to Nushell ${version} (${resolvedPath})`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      nuRuntime.error = detail
      if (options.requireNu) {
        throw new Error(
          `dsh-nushell-only: Nushell at ${resolvedPath} failed its \`--version\` probe (${detail}). `
          + 'Fix the executable, or set executor config `requireNu: false` / `verifyNu: false` to boot anyway.',
        )
      }
      log(this, 'warn', `Nushell \`--version\` probe failed (${detail}); continuing without a version`)
    }
  }

  /** The executable the executor spawns (resolved when the probe ran). */
  get nuExecutable() {
    return this.nuOptions.resolvedPath ?? this.nuOptions.executable
  }

  /** The probed Nushell version, when known. */
  get nuVersion() {
    return nuRuntime.version
  }

  /** Whether the foreign-shell guard is active. */
  get nuEnforceNushellOnly() {
    return this.nuOptions.enforce
  }

  /**
   * The exact argv one command runs as, after the Nu-only guard.
   * @param command - Nushell source from the caller.
   * @returns the argv handed to the subprocess seam.
   * @throws Error when the command hands off to another shell.
   */
  nuShellArgv(command) {
    const options = this.nuOptions
    if (options.enforce) assertNushellOnly(command, { allow: options.allow })
    return nushellArgv(command, { nuPath: this.nuExecutable, nuArgs: options.args })
  }

  /**
   * The argv seam the PowerShell family exposes; its confining sibling calls
   * `this.argv(spec)` from both `run` and `confine`.
   * @param spec - the resolved execution spec.
   * @returns the Nushell argv for this spec.
   */
  argv(spec) {
    return this.nuShellArgv(spec.command)
  }

  /**
   * The confinement seam of the POSIX family (`confine(command, policy)`) and
   * of the Windows family (`confine(spec, policy)`): wrap the Nushell argv
   * through `ctx.sandbox`, keeping the provider's own enforcement and
   * classification facts.
   * @param subject - the command string (POSIX) or the resolved spec (Windows).
   * @param policy - the per-call sandbox policy.
   * @returns the sandbox provider's wrap result.
   */
  confine(subject, policy) {
    const command = typeof subject === 'string' ? subject : subject.command
    return this.ctx.sandbox.confine(this.nuShellArgv(command), policy)
  }

  /**
   * Foreground run. The confined path is the parent's (which now wraps the Nu
   * argv through the `confine` override); the unconfined path is rebuilt here so
   * `danger-full-access` does not fall back to the base shell's argv.
   * @param spec - a resolved spec from {@link resolve}.
   * @returns the settled result, with sandbox facts as the parent reports them.
   */
  async run(spec) {
    if (!isUnconfined(this, spec)) return super.run(spec)
    const result = await this.runArgv(spec, this.nuShellArgv(spec.command))
    return { ...result, sandbox: { mode: 'danger-full-access', denied: false } }
  }

  /**
   * Background start with the same split as {@link run}. Full-access background
   * handles carry no sandbox facts, exactly like the first-party executors.
   * @param spec - a resolved spec from {@link resolve}.
   * @returns the live process handle.
   */
  start(spec) {
    if (!isUnconfined(this, spec)) return super.start(spec)
    return this.startArgv(spec, this.nuShellArgv(spec.command))
  }

  /**
   * Run `nu --version` through the subprocess seam.
   * @param executable - the resolved executable path.
   * @returns the parsed version, or undefined when the output has no version.
   */
  async probeVersion(executable) {
    const signal = AbortSignal.timeout(this.nuOptions.verifyTimeoutMs)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, '--version'],
      cwd: this.config?.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1000,
      signal,
    })
    await handle.done
    const stdout = handle.collected?.stdout
    const stderr = handle.collected?.stderr
    const text = `${stdout === undefined ? '' : stdout.readFrom(0).text}${stderr === undefined ? '' : stderr.readFrom(0).text}`
    const version = parseNuVersion(text)
    if (version === undefined && text.trim().length === 0) throw new Error('no output')
    return version
  }
}

export default NushellExecutor
