# Making an agent preset Nushell-only

The bundle replaces the host `ctx.shell` provider, so any tool that runs its
commands through `ctx.shell` (`@deepseek-ai/dsh-tool-bash`,
`@deepseek-ai/dsh-tool-pwsh`, and the jobs/hook consumers built on them) runs
Nushell automatically.

A preset can also mount a tool that **spawns its own shell** and never touches
`ctx.shell`. Those rows must be disabled in the preset's `agent.cordis.yml` for
the deployment to be genuinely Nu-only. Two common shapes:

## 1. A preset-local tool that spawns a shell directly

```yaml
# Before: a custom `bash` tool that spawns Git Bash / sh through ctx.subprocess.
- id: custom-bash
  name: ./custom-bash.mjs
  disabled: !!js process.platform !== 'win32'
```

```yaml
# After: disabled. The platform's first-party shell tool remains
# (`tool-pwsh` on Windows, `tool-bash` on POSIX) and now executes Nushell,
# because `ctx.shell` is the Nushell executor.
- id: custom-bash
  name: ./custom-bash.mjs
  disabled: true
```

## 2. A PTY-backed persistent shell

```yaml
# Before: an interactive bash kept alive by @deepseek-ai/dsh-terminal-bash.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
```

```yaml
# After: disabled, and the one-shot shell tool kept. The one-shot tool runs
# Nushell per call and does not need a PTY; state does not persist between
# calls, so pass `workdir` instead of `cd`.
- id: persistent-shell
  name: cordis:group
  group: true
  disabled: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
```

If a persistent Nushell session is required, point the terminal backend at Nu
instead (readiness detection then falls back to output-silence inference, which
this package does not verify):

```yaml
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        shellDialect: bash            # the readiness stack only knows bash/pwsh
        shellPath: nu                 # ... but the executable may be any program
        shellArgs: ['--no-config-file', '--interactive']
```

## Checking a preset

Boot the profile and inspect the composed prompt and catalog:

```sh
dsh --profile web --dump-config | grep -n -i "bash\|pwsh\|terminal"
```

Every `bash` / `pwsh` row that survives should be one of the first-party tools
(`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-pwsh`); a row that names a
custom module which spawns a shell is the bypass to disable.
