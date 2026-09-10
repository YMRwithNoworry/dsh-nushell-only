/**
 * Teaching-layer tests: what the plugin registers, what it rewrites, and how it
 * refuses a bad configuration. No dsh boot is needed — the plugin's contract is
 * the prompt registry and the assembly waterfall.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GUIDE_SECTION, RULES_SECTION, apply, normalizeConfig } from '../lib/teaching.js'
import { nuRuntime } from '../lib/nu.js'

/** A minimal stand-in for the `ctx` surface the teaching plugin injects. */
function mockContext(order = 1000) {
  const sections = []
  const listeners = new Map()
  const infos = []
  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      getSectionOrder() {
        return order
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    logger: {
      info(message) {
        infos.push(message)
      },
      warn() {},
    },
  }
  return { ctx, sections, listeners, infos }
}

/** One assembled shell tool schema, shaped like the assembly's JSON Schema view. */
function shellTool(name, properties) {
  const dialect = name === 'pwsh' ? 'PowerShell command (`pwsh -Command`)' : 'bash command (`bash -c`)'
  return {
    name,
    description: `Execute a ${dialect} and return its stdout/stderr.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: `The ${name} command to execute.` },
        ...properties,
      },
    },
  }
}

test('registers the rules section and the guide section at the shell order', () => {
  const { ctx, sections } = mockContext(1000)
  apply(ctx, {})
  assert.deepEqual(sections.map((section) => section.name), [RULES_SECTION, GUIDE_SECTION])
  assert.deepEqual(sections.map((section) => section.order), [1000, 1001])
  assert.equal(typeof sections[1].text, 'function')
  assert.match(sections[0].text, /Nushell only/)
})

test('the guide section reports the probed Nushell version', () => {
  const previous = nuRuntime.version
  nuRuntime.version = '9.9.9'
  try {
    const { ctx, sections } = mockContext()
    apply(ctx, {})
    assert.match(sections[1].text(), /Nushell 9\.9\.9/)
  } finally {
    nuRuntime.version = previous
  }
})

test('guide: off and rules: false remove their sections', () => {
  const off = mockContext()
  apply(off.ctx, { guide: 'off' })
  assert.deepEqual(off.sections.map((section) => section.name), [RULES_SECTION])

  const noRules = mockContext()
  apply(noRules.ctx, { rules: false })
  assert.deepEqual(noRules.sections.map((section) => section.name), [GUIDE_SECTION])

  const none = mockContext()
  apply(none.ctx, { rules: false, guide: 'off' })
  assert.equal(none.sections.length, 0)
})

test('rewrites bash and pwsh descriptions, keeps other tools and semantics', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, {})
  const assemble = listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')

  const bash = shellTool('bash', {
    run_in_background: { type: 'boolean' },
    sandbox_permissions: { type: 'string' },
    justification: { type: 'string' },
  })
  const pwsh = shellTool('pwsh', {})
  const read = { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  const assembly = { sections: [], contexts: [], variables: {}, tools: [bash, pwsh, read] }

  const result = await assemble(assembly, {}, async () => assembly)
  assert.notEqual(result, assembly, 'the listener returns a new assembly')
  assert.notEqual(result.tools, assembly.tools, 'the listener returns a new tool list')
  assert.equal(result.tools[2], read, 'non-shell tools pass through untouched')

  const [rewrittenBash, rewrittenPwsh] = result.tools
  assert.equal(rewrittenBash.name, 'bash', 'the tool keeps its name for presets and toolOrder lists')
  assert.match(rewrittenBash.description, /dialect is Nushell/)
  assert.doesNotMatch(rewrittenBash.description, /bash -c/)
  assert.match(rewrittenBash.description, /run_in_background/, 'background support is derived from the schema')
  assert.match(rewrittenBash.description, /sandbox_permissions/, 'escalation support is derived from the schema')
  assert.match(rewrittenBash.parameters.properties.command.description, /Nushell syntax/)
  assert.match(rewrittenPwsh.description, /Background execution is not available/)
  assert.doesNotMatch(rewrittenPwsh.description, /pwsh -Command/)
})

test('leaves the original schema objects unmodified', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, {})
  const bash = shellTool('bash', {})
  const assembly = { sections: [], contexts: [], variables: {}, tools: [bash] }
  await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  assert.match(bash.description, /Execute a bash command/)
  assert.equal(bash.parameters.properties.command.description, 'The bash command to execute.')
})

test('a tool named bash that is not a shell tool is left alone', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, {})
  const notAShell = { name: 'bash', description: 'Unrelated.', parameters: { type: 'object', properties: { script: { type: 'string' } } } }
  const assembly = { sections: [], contexts: [], variables: {}, tools: [notAShell] }
  const result = await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  assert.equal(result.tools[0], notAShell)
})

test('toolNames config narrows the rewrite surface', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, { toolNames: ['pwsh'] })
  const bash = shellTool('bash', {})
  const pwsh = shellTool('pwsh', {})
  const assembly = { sections: [], contexts: [], variables: {}, tools: [bash, pwsh] }
  const result = await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  assert.equal(result.tools[0], bash, 'bash is out of scope')
  assert.doesNotMatch(result.tools[1].description, /pwsh -Command/)
})

test('rewriteToolDescriptions: false registers no waterfall listener', () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, { rewriteToolDescriptions: false })
  assert.equal(listeners.has('system-prompt/assemble'), false)
})

test('a custom tool that spawns its own shell keeps its own honest description', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, {})
  // The shape a preset's own bash tool has: same tool name, same `command`
  // parameter, but it spawns Git Bash through ctx.subprocess. The teaching
  // layer must not claim it runs Nushell.
  const custom = {
    name: 'bash',
    description: 'Run commands in a bash shell (Git Bash on Windows)\n* State does NOT persist across command calls.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute (`bash -c` string domain).' } } },
  }
  const assembly = { sections: [], contexts: [], variables: {}, tools: [custom] }
  const result = await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  assert.equal(result.tools[0], custom)
})

test('an already-rewritten description stays stable across assemblies', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, {})
  const bash = shellTool('bash', {})
  const assembly = { sections: [], contexts: [], variables: {}, tools: [bash] }
  const once = await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  const twice = await listeners.get('system-prompt/assemble')({ ...assembly, tools: once.tools }, {}, async () => assembly)
  assert.equal(twice.tools[0].description, once.tools[0].description)
})

test('a malformed config fails at load', () => {
  assert.throws(() => normalizeConfig({ guide: 'verbose' }), /guide must be/)
  assert.throws(() => normalizeConfig({ toolNames: 'bash' }), /toolNames must be/)
  assert.throws(() => normalizeConfig({ toolNames: ['', 1] }), /toolNames must be/)
})
