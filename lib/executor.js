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
 * ## The 0.1.7 shell seam
 *
 * Since dsh `0.1.7-rc.1` the seam has ONE execution verb:
 * `execute(spec) -> ShellExecution`. The `run` / `start` / `runArgv` /
 * `startArgv` set the 0.1.5 line exposed is gone, and `ShellExecution` is the
 * live process handle plus the memoized foreground projection `result()`. This
 * class therefore overrides:
 *
 * - `execute(spec)` — the one entry point. The `danger-full-access` branch is
 *   rebuilt here so it cannot fall back to the base shell's argv, and the
 *   confined branch delegates to the base executor (which wraps
 *   `this.nuShellArgv` through the `confine` override below).
 * - `argv(spec)` — the argv seam the pwsh family exposes, and the one its
 *   confining sibling calls from `execute` (both branches).
 * - `confine(subject, policy, signal)` — the confinement seam. The bash family
 *   passes the command string and the pwsh family the resolved spec, so the
 *   override accepts either; `signal` is the provider's cancellation, forwarded
 *   to the sandbox provider unchanged.
 *
 * All three overrides are written platform-agnostically: the class works
 * whichever base it resolved, and `execute` produces identical results on both.
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
import { assertNushellDialect, dialectHint } from './dialect.js'
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

/**
 * The per-call sandbox policy of a spec, defaulted exactly the way the base
 * executor's own `resolve` defaults it. A caller that hand-built a spec without
 * resolving it would otherwise run unconfined, which is the wrong direction to
 * fail — the deployment policy is the safe default.
 * @param executor - the executor holding the sandbox-policy service.
 * @param spec - the resolved (or hand-built) execution spec.
 * @returns the policy to honor, or undefined when no policy service exists.
 */
function policyOf(executor, spec) {
  return spec.sandboxPolicy ?? executor.ctx.sandboxPolicy?.resolve?.()
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
 * | `foreignShellAllowlist` | `[]` | Whole-command regexes exempt from the guard and the dialect lint. |
 * | `dialectLint` | `true` | Refuse bash/PowerShell habits (`2>&1`, `$env:VAR`, `$x = …`, `foreach`, cmdlets, `glob a b`) before spawning. |
 * | `dialectHints` | `true` | Append one actionable hint to stderr when Nushell reports a known mistake (missing path, absent column, wrong input type). |
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
      lint: source.dialectLint !== false,
      hints: source.dialectHints !== false,
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
   * The exact argv one command runs as, after the Nu-only guard and the dialect
   * preflight. Both refusals happen before a subprocess exists, so a habit the
   * model can fix cheaply costs nothing to fail.
   * @param command - Nushell source from the caller.
   * @returns the argv handed to the subprocess seam.
   * @throws Error when the command hands off to another shell, or uses bash/PowerShell syntax.
   */
  nuShellArgv(command) {
    const options = this.nuOptions
    if (options.enforce) assertNushellOnly(command, { allow: options.allow })
    if (options.lint) assertNushellDialect(command, { allow: options.allow })
    return nushellArgv(command, { nuPath: this.nuExecutable, nuArgs: options.args })
  }

  /**
   * The argv seam the PowerShell family exposes; its confining sibling calls
   * `this.argv(spec)` from `execute` (both the confined and the full-access
   * branch reach it).
   * @param spec - the resolved execution spec.
   * @returns the Nushell argv for this spec.
   */
  argv(spec) {
    return this.nuShellArgv(spec.command)
  }

  /**
   * The confinement seam of the POSIX family (`confine(command, policy, signal)`)
   * and of the Windows family (`confine(spec, policy, signal)`): wrap the
   * Nushell argv through `ctx.sandbox`, keeping the provider's own enforcement
   * and classification facts. Provider errors propagate unchanged.
   * @param subject - the command string (POSIX) or the resolved spec (Windows).
   * @param policy - the per-call sandbox policy.
   * @param signal - cancellation of confinement preparation.
   * @returns the sandbox provider's wrap result.
   */
  confine(subject, policy, signal) {
    const command = typeof subject === 'string' ? subject : subject.command
    return this.ctx.sandbox.confine(this.nuShellArgv(command), policy, signal)
  }

  /**
   * The one execution entry point of the 0.1.7 seam: the confined path is the
   * parent's (which now wraps the Nu argv through the `confine` override), and
   * the unconfined path is rebuilt here so `danger-full-access` never falls back
   * to the base shell's argv. Either way the returned handle's foreground
   * projection carries the Nushell hint.
   * @param spec - a resolved spec from {@link resolve}.
   * @returns the live execution handle, exactly one per call.
   */
  async execute(spec) {
    const policy = policyOf(this, spec)
    const mode = policy?.mode
    if (mode === undefined || mode === 'danger-full-access') {
      const handle = await this.executeArgv(spec, this.nuShellArgv(spec.command))
      return NushellExecutor.decorateResult(handle, (result) => this.withDialectHint(spec, {
        ...result,
        sandbox: { mode: mode ?? 'danger-full-access', denied: false },
      }))
    }
    // The base executor reads `spec.sandboxPolicy` itself, so a hand-built spec
    // is stamped with the policy we just defaulted before it is delegated to.
    const delegated = spec.sandboxPolicy === undefined ? { ...spec, sandboxPolicy: policy } : spec
    const handle = await super.execute(delegated)
    return NushellExecutor.decorateResult(handle, (result) => this.withDialectHint(spec, result))
  }

  /**
   * Append one actionable Nushell hint to a failed command's stderr. The hint
   * is chosen from the error Nushell reported, so it answers the failure that
   * actually happened (`2>&1` refused by the parser, a missing path, an absent
   * column, a wrong input type) instead of repeating the whole guide.
   * @param spec - the resolved spec the command came from.
   * @param result - the settled run result.
   * @returns the result, with the hint appended to its stderr when one applies.
   */
  withDialectHint(spec, result) {
    if (!this.nuOptions.hints) return result
    const stderr = result?.stderr
    const text = typeof stderr?.text === 'string' ? stderr.text : undefined
    if (text === undefined) return result
    const hint = dialectHint(spec.command, text, { exitCode: result.exitCode, stdout: result.stdout?.text })
    if (hint === undefined) return result
    const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    return { ...result, stderr: { ...stderr, text: `${text}${separator}${hint}\n` } }
  }

  /** The working directory the boot probe spawns in (`config.cwd` is a live schema ref). */
  probeCwd() {
    const declared = this.config?.cwd
    const value = typeof declared?.get === 'function' ? declared.get() : declared
    return typeof value === 'string' && value.length > 0 ? value : process.cwd()
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
      cwd: this.probeCwd(),
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
