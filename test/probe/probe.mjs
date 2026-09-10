/**
 * Integration self-test: boots inside a real dsh composition (the plugin
 * installed as a profile bundle) and checks, at runtime, the promises the
 * plugin makes — that the shell seam runs Nushell, that a foreign-shell handoff
 * is refused, and that the model-facing prompt and tool schemas describe
 * Nushell. Exits 0 when every check passes.
 *
 * Run it through `test/integration.mjs`, which creates the scratch profile.
 *
 * Two properties of a real boot shape this probe:
 *
 * - A composition booted with `--patch` overlays applies its include list more
 *   than once, disposing and recreating plugin fibers. A check that spans an
 *   await can therefore find its context inactive; the preset-scoped block runs
 *   first, and an inactive context is reported as a skip rather than a failure.
 * - A web composition mounts the shell tools inside agent presets, not on the
 *   host plane, so "no global shell tool" is normal there.
 *
 * @module dsh-nushell-only/test/probe
 */

import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Services that must exist before the probe can observe anything. */
export const inject = ['shell', 'systemPrompt', 'subprocess', 'tools', 'sandboxPolicy']

const results = []
const skipped = []

function record(name, ok, detail) {
  results.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail).replace(/\s+/g, ' ').trim().slice(0, 220) })
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

function skip(name, reason) {
  skipped.push({ name, reason })
  console.log(`SKIP ${name} :: ${reason}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The assembled tool schema for one name, from the live prompt registry. */
function toolOf(assembly, name) {
  return assembly.tools.find((tool) => tool.name === name)
}

/**
 * Rendered prompt text. A deployment whose global sections reference
 * agent-supplied variables (`{{model}}` and friends) cannot render an unscoped
 * assembly, so fall back to the section texts — the guide and rules this probe
 * checks are static sections and survive either way.
 */
function promptText(assembly) {
  try {
    return renderPrompt(assembly)
  } catch {
    return assembly.sections.map((section) => section.text).join('\n\n')
  }
}

/** Whether a thrown error means this probe's fiber was disposed mid-check. */
function isInactiveContext(error) {
  return /inactive context/i.test(error instanceof Error ? error.message : String(error))
}

/** Check one exposed shell tool's schema. */
function checkShellTool(tool, label) {
  record(`${label} ${tool.name} describes Nushell`, /dialect is Nushell/.test(tool.description))
  record(`${label} ${tool.name} never claims the old dialect`, !/bash -c/.test(tool.description) && !/pwsh -Command/.test(tool.description))
  record(`${label} ${tool.name} command parameter is Nushell`, /Nushell syntax/.test(tool.parameters?.properties?.command?.description ?? ''))
}

/** Apply the probe: observe, assert, report, exit. */
export async function apply(ctx) {
  try {
    const shell = ctx.shell
    record('shell service is the Nushell executor', shell?.constructor?.name === 'NushellExecutor', shell?.constructor?.name)
    record('probed Nushell version', typeof shell.nuVersion === 'string', shell.nuVersion ?? '(unknown)')

    // An agent preset mounts its own shell tool inside a child scope. Teaching
    // has to reach it: the waterfall listener runs at the root, and a root
    // listener still receives a scoped assembly. This block goes first, before
    // any other await, so a re-applied include cannot dispose the fiber midway.
    let scopedTool
    try {
      const presetKey = { probe: 'preset-scoped-agent' }
      const presetScope = createScope(ctx, presetKey)
      presetScope.ctx.tools.register(defineTool({
        name: 'pwsh',
        description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.',
        parameters: {
          command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
          workdir: { type: 'string', description: 'Working directory for this command.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute() {
          return { text: 'scoped' }
        },
      }))
      const scopedAssembly = await ctx.systemPrompt.assemble({ scope: presetKey })
      scopedTool = toolOf(scopedAssembly, 'pwsh')
      record('a preset-scoped shell tool is reachable', scopedTool !== undefined)
      if (scopedTool !== undefined) checkShellTool(scopedTool, 'preset-scoped')
      record('a scoped assembly still renders the guide', promptText(scopedAssembly).includes('Nushell syntax guide'))
    } catch (error) {
      if (!isInactiveContext(error)) throw error
      skip('preset-scoped shell tool checks', 'the include was re-applied and disposed this fiber')
    }

    const builtin = await shell.run(shell.resolve({ command: 'version | get version' }))
    record('runs a Nushell builtin pipeline', builtin.exitCode === 0 && /^\d+\.\d+/.test(builtin.stdout.text.trim()), builtin.stdout.text)

    const table = await shell.run(shell.resolve({ command: 'ls | where type == file | length' }))
    record('runs a Nushell table pipeline', table.exitCode === 0 && /^\d+$/.test(table.stdout.text.trim()), table.stdout.text)
    const expectedMode = ctx.sandboxPolicy?.defaultMode
    record('the run reports its sandbox facts', expectedMode === undefined || table.sandbox?.mode === expectedMode, `expected ${expectedMode}, reported ${table.sandbox?.mode}`)

    const external = await shell.run(shell.resolve({ command: '^git --version | str trim' }))
    record('runs an external command through Nushell', external.exitCode === 0 && /git version/.test(external.stdout.text), external.stdout.text)

    const failure = await shell.run(shell.resolve({ command: 'this-is-not-a-nu-command' }))
    record('reports a non-zero exit instead of throwing', failure.exitCode !== 0, `exit ${failure.exitCode}`)

    let refused = ''
    try {
      await shell.run(shell.resolve({ command: 'bash -c "echo hi"' }))
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    record('refuses a foreign-shell handoff', /Nushell-only/.test(refused), refused)

    let assembly
    for (let attempt = 0; attempt < 100; attempt++) {
      assembly = await ctx.systemPrompt.assemble()
      if (toolOf(assembly, 'bash') !== undefined || toolOf(assembly, 'pwsh') !== undefined) break
      await sleep(100)
    }
    const prompt = promptText(assembly)
    record('system prompt carries the shell rules', prompt.includes('Shell: Nushell only'))
    record('system prompt carries the syntax guide', prompt.includes('Nushell syntax guide'))
    record('system prompt carries the translation table', prompt.includes('PowerShell → Nushell'))
    record('system prompt teaches the freshness contract', prompt.includes('workdir'))

    // A host composition (TUI, headless) keeps the shell tool globally; a web
    // composition mounts it per preset, which the scoped block above covers.
    const globalShellTools = assembly.tools.filter((tool) => tool.name === 'bash' || tool.name === 'pwsh')
    const observed = scopedTool === undefined ? globalShellTools : [...globalShellTools, scopedTool]
    if (observed.length === 0) {
      skip('the composition exposes a shell tool', 'no global shell tool, and the preset-scoped check was skipped')
    } else {
      record('the composition exposes a shell tool', true, observed.map((tool) => tool.name).join(','))
    }
    for (const tool of globalShellTools) checkShellTool(tool, 'host')

    const failed = results.filter((result) => !result.ok)
    console.log(`PROBE ${failed.length === 0 ? 'OK' : 'FAILED'} (${results.length - failed.length}/${results.length} checks${skipped.length === 0 ? '' : `, ${skipped.length} skipped`})`)
    process.exit(failed.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(`PROBE ERROR: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(2)
  }
}

// Plugin metadata must sit on the function itself: the harness's module loader
// unwraps a `default` export before reading it.
apply.inject = inject
