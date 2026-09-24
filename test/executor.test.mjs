/**
 * Executor tests: the argv seam, the guard's reach, and the confined and
 * full-access paths — driven through a stand-in subprocess seam, so no dsh boot
 * and no real command is needed.
 *
 * Since dsh `0.1.7-rc.1` the shell seam has one execution verb, `execute(spec)`,
 * which resolves with a live handle whose `result()` is the memoized foreground
 * projection; these tests drive that contract.
 *
 * The `@deepseek-ai/*` peer packages the executor extends are resolved from the
 * dsh installation that `dev/link-peers.mjs` links into `node_modules/` for
 * local development.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { NushellExecutor } from '../lib/executor.js'

/**
 * A `ctx.subprocess` handle: collects what the executor asked for, never spawns.
 *
 * `defer: true` keeps the process alive until the returned handle's `release()`
 * is called, so a test can observe the live state a real, still-running child
 * would show.
 */
function fakeSubprocess({ exitCode = 0, stdout = 'ok', stderr = '', fail = false, defer = false } = {}) {
  const spawns = []
  const procs = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length }) })
  const spawn = (spec) => {
    spawns.push(spec)
    let release
    const outcome = defer ? new Promise((resolve) => { release = resolve }) : Promise.resolve()
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: fail
        ? Promise.reject(new Error('spawn failed'))
        : outcome.then(() => ({ exitCode, signal: null })),
      collected: {
        stdout: reader(stdout),
        stderr: reader(stderr),
      },
      release: () => release?.(),
      terminate() {
        proc.status = 'killed'
      },
    }
    procs.push(proc)
    return proc
  }
  return { spawn, spawns, procs }
}

/** A `ctx` stand-in covering the services the executor and its base class touch. */
function fakeContext({ subprocess, sandboxMode = 'danger-full-access', confine = (argv) => argv } = {}) {
  const confined = []
  const ctx = {
    inject() {},
    // The cordis `Service` base class registers itself through `ctx.reflect.provide`.
    reflect: { provide: () => () => {} },
    get: () => undefined,
    subprocess,
    sandboxPolicy: {
      defaultMode: sandboxMode,
      resolve: () => ({ mode: sandboxMode, workspaceRoot: process.cwd() }),
    },
    sandbox: {
      confine(argv, policy, signal) {
        confined.push({ argv, policy, signal })
        return {
          argv: confine(argv, policy),
          enforcement: 'strict',
          denialSignatures: ['denied'],
          runnerFailureRules: [],
        }
      },
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, confined }
}

const baseConfig = {
  cwd: process.cwd(),
  timeoutMs: 5000,
  maxTimeoutMs: 10000,
  maxOutputBytes: 4096,
  maxSpillBytes: 65536,
  graceMs: 100,
  nuPath: 'nu',
  requireNu: false,
  verifyNu: false,
}

/**
 * Resolve a config the way the cordis plugin loader does. The inherited
 * executor schema declares its budget fields `volatile`, so the base class reads
 * them through `.get()` and only a schema-resolved config is serviceable.
 */
function resolveConfig(raw) {
  return Schema.resolve({ ...raw }, NushellExecutor.Config)[0]
}

function makeExecutor(options = {}) {
  const subprocess = options.subprocess ?? fakeSubprocess()
  const { ctx, confined } = fakeContext({ subprocess, sandboxMode: options.sandboxMode, confine: options.confine })
  const executor = new NushellExecutor(ctx, resolveConfig({ ...baseConfig, ...options.config }))
  return { executor, subprocess, confined, ctx }
}

/** Run one request to settlement: the foreground projection of `execute`. */
async function settle(executor, request) {
  const handle = await executor.execute(executor.resolve(request))
  return handle.result()
}

test('builds the documented Nushell argv', () => {
  const { executor } = makeExecutor()
  assert.deepEqual(executor.nuShellArgv('ls | where type == file'), ['nu', '--no-config-file', '-c', 'ls | where type == file'])
  assert.deepEqual(executor.argv({ command: 'ls' }), ['nu', '--no-config-file', '-c', 'ls'])
})

test('honors nuPath, nuArgs, and $DSH_NU_PATH-less defaults', () => {
  const { executor } = makeExecutor({ config: { nuPath: 'C:\\nu\\nu.exe', nuArgs: ['-n', '-c'] } })
  assert.deepEqual(executor.nuShellArgv('ls'), ['C:\\nu\\nu.exe', '-n', '-c', 'ls'])
  assert.equal(executor.nuExecutable, 'C:\\nu\\nu.exe')
})

test('refuses a foreign-shell handoff from both entry points', () => {
  const { executor } = makeExecutor()
  assert.throws(() => executor.nuShellArgv('bash -c "echo hi"'), /Nushell-only/)
  assert.throws(() => executor.argv({ command: 'cmd /c dir' }), /Nushell-only/)
  assert.throws(() => executor.confine('pwsh -Command ls', { mode: 'workspace-write' }), /Nushell-only/)
})

test('the guard can be disabled or allowlisted', () => {
  const off = makeExecutor({ config: { enforceNushellOnly: false } })
  assert.deepEqual(off.executor.nuShellArgv('bash -c x'), ['nu', '--no-config-file', '-c', 'bash -c x'])

  const allow = makeExecutor({ config: { foreignShellAllowlist: ['^bash -c "legacy"$'] } })
  assert.deepEqual(allow.executor.nuShellArgv('bash -c "legacy"'), ['nu', '--no-config-file', '-c', 'bash -c "legacy"'])
  assert.throws(() => allow.executor.nuShellArgv('bash -c "other"'), /Nushell-only/)
})

test('a dangerous malformed allowlist fails at construction', () => {
  assert.throws(() => makeExecutor({ config: { foreignShellAllowlist: ['('] } }), /valid regular expression/)
  assert.throws(() => makeExecutor({ config: { nuArgs: [] } }), /nuArgs/)
})

test('full-access execution spawns Nushell and reports unconfined facts', async () => {
  const { executor, subprocess, confined } = makeExecutor({ sandboxMode: 'danger-full-access' })
  const result = await settle(executor, { command: 'print "hi"' })
  assert.equal(subprocess.spawns.length, 1)
  assert.deepEqual(subprocess.spawns[0].argv, ['nu', '--no-config-file', '-c', 'print "hi"'])
  assert.equal(subprocess.spawns[0].cwd, process.cwd())
  assert.equal(confined.length, 0, 'the full-access path never asks the sandbox to wrap')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'ok')
})

test('the handle exposes the live process and one memoized result', async () => {
  const subprocess = fakeSubprocess({ defer: true })
  const { executor } = makeExecutor({ subprocess, sandboxMode: 'danger-full-access' })
  const handle = await executor.execute(executor.resolve({ command: 'print "hi"' }))
  assert.equal(handle.status, 'running')
  assert.equal(typeof handle.readOutput, 'function')
  assert.equal(handle.result(), handle.result(), 'result() is memoized')
  subprocess.procs[0].release()
  await handle.result()
  assert.equal(handle.status, 'completed')
  assert.equal(subprocess.spawns.length, 1)
})

test('confined execution wraps the Nushell argv through ctx.sandbox', async () => {
  const { executor, subprocess, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const result = await settle(executor, { command: 'ls' })
  assert.deepEqual(confined[0].argv, ['nu', '--no-config-file', '-c', 'ls'])
  assert.equal(confined[0].policy.mode, 'workspace-write')
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'nu', '--no-config-file', '-c', 'ls'])
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'strict' })
})

test('a hand-built spec without a policy fails closed onto the deployment policy', async () => {
  const { executor, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const handle = await executor.execute({
    command: 'ls',
    workdir: process.cwd(),
    timeoutMs: 5000,
    onExpiry: 'kill',
    stdoutMaxBytes: 4096,
    sandboxPolicy: undefined,
  })
  await handle.result()
  assert.equal(confined.length, 1, 'the unset policy defaulted to the deployment mode, not to no confinement')
  assert.equal(confined[0].policy.mode, 'workspace-write')
})

test('a refusal inside a confined call happens before the sandbox is asked to wrap', async () => {
  const { executor, confined } = makeExecutor({ sandboxMode: 'workspace-write' })
  await assert.rejects(() => executor.execute(executor.resolve({ command: 'bash -c ls' })), /Nushell-only/)
  assert.equal(confined.length, 0)
})

test('background execution returns a live handle that can be killed', async () => {
  const subprocess = fakeSubprocess({ defer: true })
  const { executor } = makeExecutor({ subprocess, sandboxMode: 'danger-full-access' })
  const handle = await executor.execute(executor.resolve({ command: 'sleep 1sec', onExpiry: 'none' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['nu', '--no-config-file', '-c', 'sleep 1sec'])
  assert.equal(handle.status, 'running')
  assert.equal(handle.kill(), true)
  assert.equal(handle.status, 'killed')
  subprocess.procs[0].release()
  await handle.done
})

test('confined background runs wrap the Nushell argv and stamp sandbox facts on settlement', async () => {
  const { executor, subprocess } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const handle = await executor.execute(executor.resolve({ command: 'ls', onExpiry: 'none' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'nu', '--no-config-file', '-c', 'ls'])
  await handle.done
  assert.equal(handle.status, 'completed')
  assert.equal(handle.sandbox?.mode, 'workspace-write')
  assert.equal(handle.sandbox?.denied, false)
})

test('a failed call carries the Nushell hint on its foreground projection', async () => {
  const subprocess = fakeSubprocess({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: nu::shell::io::not_found\n\n  × File not found\n',
  })
  const { executor } = makeExecutor({ subprocess, sandboxMode: 'danger-full-access' })
  const result = await settle(executor, { command: 'open missing.txt' })
  assert.match(result.stderr.text, /Nushell hint \(path-not-found\)/)
  assert.equal(result.stderr.text.includes('File not found'), true, 'the original Nushell error survives')
})

test('the resolve path keeps the inherited budgets and the caller workdir', () => {
  const { executor } = makeExecutor()
  const spec = executor.resolve({ command: 'ls', workdir: 'D:\\work', timeoutMs: 999_999 })
  assert.equal(spec.workdir, 'D:\\work')
  assert.equal(spec.timeoutMs, 10000, 'per-call timeout is capped by maxTimeoutMs')
  assert.equal(spec.stdoutMaxBytes, 4096)
})
