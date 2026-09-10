/**
 * Executor tests: the argv seam, the guard's reach, and the confined and
 * full-access paths — driven through a stand-in subprocess seam, so no dsh boot
 * and no real command is needed.
 *
 * The `@deepseek-ai/*` peer packages the executor extends are resolved from the
 * dsh installation that `dev/link-peers.mjs` links into `node_modules/` for
 * local development.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NushellExecutor } from '../lib/executor.js'

/** A `ctx.subprocess` handle: collects what the executor asked for, never spawns. */
function fakeSubprocess({ exitCode = 0, stdout = 'ok', stderr = '', fail = false } = {}) {
  const spawns = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length }) })
  const spawn = (spec) => {
    spawns.push(spec)
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: fail
        ? Promise.reject(new Error('spawn failed'))
        : Promise.resolve({ exitCode, signal: null }),
      collected: {
        stdout: reader(stdout),
        stderr: reader(stderr),
      },
      terminate() {
        proc.status = 'killed'
      },
    }
    return proc
  }
  return { spawn, spawns }
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
    sandboxPolicy: { resolve: () => ({ mode: sandboxMode, workspaceRoot: process.cwd() }) },
    sandbox: {
      confine(argv, policy) {
        confined.push({ argv, policy })
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

function makeExecutor(options = {}) {
  const subprocess = options.subprocess ?? fakeSubprocess()
  const { ctx, confined } = fakeContext({ subprocess, sandboxMode: options.sandboxMode, confine: options.confine })
  const executor = new NushellExecutor(ctx, { ...baseConfig, ...options.config })
  return { executor, subprocess, confined, ctx }
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

test('full-access foreground runs spawn Nushell and report unconfined facts', async () => {
  const { executor, subprocess } = makeExecutor({ sandboxMode: 'danger-full-access' })
  const result = await executor.run(executor.resolve({ command: 'print "hi"' }))
  assert.equal(subprocess.spawns.length, 1)
  assert.deepEqual(subprocess.spawns[0].argv, ['nu', '--no-config-file', '-c', 'print "hi"'])
  assert.equal(subprocess.spawns[0].cwd, process.cwd())
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'ok')
})

test('confined foreground runs wrap the Nushell argv through ctx.sandbox', async () => {
  const { executor, subprocess, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const result = await executor.run(executor.resolve({ command: 'ls' }))
  assert.deepEqual(confined[0].argv, ['nu', '--no-config-file', '-c', 'ls'])
  assert.equal(confined[0].policy.mode, 'workspace-write')
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'nu', '--no-config-file', '-c', 'ls'])
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'strict' })
})

test('a refusal inside a confined call happens before the sandbox is asked to wrap', async () => {
  const { executor, confined } = makeExecutor({ sandboxMode: 'workspace-write' })
  await assert.rejects(() => executor.run(executor.resolve({ command: 'bash -c ls' })), /Nushell-only/)
  assert.equal(confined.length, 0)
})

test('background starts spawn Nushell and expose a live handle', async () => {
  const { executor, subprocess } = makeExecutor({ sandboxMode: 'danger-full-access' })
  const proc = executor.start(executor.resolve({ command: 'sleep 1sec' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['nu', '--no-config-file', '-c', 'sleep 1sec'])
  assert.equal(proc.status, 'running')
  assert.equal(proc.kill(), true)
  assert.equal(proc.status, 'killed')
  await proc.done
})

test('confined background runs wrap the Nushell argv and stamp sandbox facts on settlement', async () => {
  const { executor, subprocess } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const proc = executor.start(executor.resolve({ command: 'ls' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'nu', '--no-config-file', '-c', 'ls'])
  await proc.done
  assert.equal(proc.status, 'completed')
  assert.equal(proc.sandbox?.mode, 'workspace-write')
  assert.equal(proc.sandbox?.denied, false)
})

test('the resolve path keeps the inherited budgets and the caller workdir', () => {
  const { executor } = makeExecutor()
  const spec = executor.resolve({ command: 'ls', workdir: 'D:\\work', timeoutMs: 999_999 })
  assert.equal(spec.workdir, 'D:\\work')
  assert.equal(spec.timeoutMs, 10000, 'per-call timeout is capped by maxTimeoutMs')
  assert.equal(spec.stdoutMaxBytes, 4096)
})
