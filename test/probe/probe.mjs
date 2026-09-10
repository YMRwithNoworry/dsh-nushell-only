/**
 * Integration self-test: boots inside a real dsh composition (the plugin
 * installed as a profile bundle) and checks, at runtime, the promises the
 * plugin makes — that the shell seam runs Nushell, that a foreign-shell handoff
 * is refused, and that the model-facing prompt and tool schemas describe
 * Nushell. Exits 0 when every check passes.
 *
 * Run it through `test/integration.mjs`, which creates the scratch profile.
 *
 * @module dsh-nushell-only/test/probe
 */

import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Services that must exist before the probe can observe anything. */
export const inject = ['shell', 'systemPrompt', 'subprocess', 'tools', 'sandboxPolicy']

const results = []

function record(name, ok, detail) {
  results.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail).replace(/\s+/g, ' ').trim().slice(0, 220) })
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The assembled tool schema for one name, from the live prompt registry. */
function toolOf(assembly, name) {
  return assembly.tools.find((tool) => tool.name === name)
}

/** Apply the probe: observe, assert, report, exit. */
export async function apply(ctx) {
  try {
    const shell = ctx.shell
    record('shell service is the Nushell executor', shell?.constructor?.name === 'NushellExecutor', shell?.constructor?.name)
    record('probed Nushell version', typeof shell.nuVersion === 'string', shell.nuVersion ?? '(unknown)')

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
    const prompt = renderPrompt(assembly)
    record('system prompt carries the shell rules', prompt.includes('Shell: Nushell only'))
    record('system prompt carries the syntax guide', prompt.includes('Nushell syntax guide'))
    record('system prompt carries the translation table', prompt.includes('PowerShell → Nushell') || prompt.includes('PowerShell \u2192 Nushell'))
    record('system prompt teaches the freshness contract', prompt.includes('workdir'))

    const shellTools = assembly.tools.filter((tool) => tool.name === 'bash' || tool.name === 'pwsh')
    record('the composition exposes a shell tool', shellTools.length > 0, shellTools.map((tool) => tool.name).join(','))
    for (const tool of shellTools) {
      record(`tool ${tool.name} describes Nushell`, /dialect is Nushell/.test(tool.description))
      record(`tool ${tool.name} never claims the old dialect`, !/bash -c/.test(tool.description) && !/pwsh -Command/.test(tool.description))
      record(`tool ${tool.name} command parameter is Nushell`, /Nushell syntax/.test(tool.parameters?.properties?.command?.description ?? ''))
    }

    // An agent preset mounts its own shell tool inside a child scope. Teaching
    // has to reach it: the waterfall listener runs at the root, and a root
    // listener still receives a scoped assembly.
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
    const scopedTool = toolOf(scopedAssembly, 'pwsh')
    record('a preset-scoped shell tool is reachable', scopedTool !== undefined)
    record('a preset-scoped shell tool is rewritten too', /dialect is Nushell/.test(scopedTool?.description ?? ''), scopedTool?.description)
    record('a preset-scoped command parameter is rewritten too', /Nushell syntax/.test(scopedTool?.parameters?.properties?.command?.description ?? ''))
    record('a scoped assembly still renders the guide', renderPrompt(scopedAssembly).includes('Nushell syntax guide'))

    const failed = results.filter((result) => !result.ok)
    console.log(`PROBE ${failed.length === 0 ? 'OK' : 'FAILED'} (${results.length - failed.length}/${results.length} checks)`)
    process.exit(failed.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(`PROBE ERROR: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(2)
  }
}

// Plugin metadata must sit on the function itself: the harness's module loader
// unwraps a `default` export before reading it.
apply.inject = inject
