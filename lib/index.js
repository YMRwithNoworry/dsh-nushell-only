/**
 * `dsh-nushell-only` — a DeepSeek Harness profile bundle that makes Nushell the
 * harness's only shell and teaches the model to write it.
 *
 * The bundle patch (`cordis.patch.yml`) mounts two rows:
 *
 * - `dsh-nushell-only/executor` — the `ctx.shell` provider that runs every
 *   command as `nu --no-config-file -c "<command>"` (plus the Nu-only guard).
 * - `dsh-nushell-only/teaching` — prompt sections and tool-description rewrites.
 *
 * This root module re-exports both surfaces for programmatic use; its default
 * export is the teaching plugin, so a composition that mounts the bare package
 * name gets the teaching layer while `dsh-nushell-only/executor` stays the
 * explicit executor row.
 *
 * @module dsh-nushell-only
 */

export { NushellExecutor, inject as executorInject, name as executorName } from './executor.js'
export { apply as applyTeaching, normalizeConfig as normalizeTeachingConfig, RULES_SECTION, GUIDE_SECTION } from './teaching.js'
export { buildGuide, buildShellRules, buildToolDescription, NUSHELL_COMMAND_PARAM_DESCRIPTION } from './guide.js'
export { assertNushellOnly, findForeignShellHandoff, programName, splitStatements } from './guard.js'
export { DEFAULT_NU_ARGS, nushellArgv, nuRuntime, parseNuVersion, resolveNuPath } from './nu.js'
export { apply as default } from './teaching.js'
