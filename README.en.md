# dsh-nushell-only

English | [中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) profile bundle that makes **Nushell the harness's only shell** and **teaches the model to write it**.

Targets **dsh `0.1.5-rc.2`** (verified against `0.1.5-rc.2` and against a `0.1.5-rc.1` CLI with `0.1.5-rc.2` packages). Requires Node `>=22.19.0` and [Nushell](https://www.nushell.sh/) (verified with `0.115.1`; `>=0.100` recommended).

## What it does

Three cooperating pieces:

1. **Owns `ctx.shell` (execution).** The two first-party executors (`bash-sandbox`, `pwsh-sandbox`) are disabled and replaced by `dsh-nushell-only/executor`, so every shell command becomes
   `nu --no-config-file -c "<command>"`.
   Because the replacement is at the capability seam rather than at the model tool, *every* `ctx.shell` consumer runs Nushell: the model tools, background jobs, the hook bridges (`dsh-hooks-*`), `tmux-context`, and any in-process caller. Timeouts, output caps, spill files, background handles, cancellation, the sandbox wrap, and its denial/runner-failure facts all stay the first-party implementation (the executor extends `SandboxBashExecutor` / `SandboxPwshExecutor` and replaces only the argv).
   `--no-config-file` keeps the user's `config.nu` / `env.nu` from changing what a tool call does.

2. **Refuses "hand it to another shell" (enforcement).** A narrow guard rejects a command whose statement starts by delegating to another shell (`bash -c`, `sh -c`, `cmd /c`, `pwsh -Command`, `wsl …`, including `sudo`/`env`/`busybox` wrappers, `^bash`, and path forms) with an actionable error and a Nushell translation, instead of letting the model hit an opaque Nu parse error. On by default; `enforceNushellOnly: false` disables it, `foreignShellAllowlist` exempts individual call sites.

3. **Teaching layer (prompt).**
   - `shell: nushell-rules` — the mandatory rules: dialect, fresh process per call, `workdir` instead of `cd`, no shell fallback, structured pipelines.
   - `shell: nushell-guide` — syntax, a bash/PowerShell → Nushell translation table, and the traps; evaluated per assembly so it carries the probed Nushell version.
   - Rewrites the model-facing `bash` / `pwsh` tool descriptions and their `command` parameter into the Nushell dialect. The tool **names** stay the same so presets, `toolOrder` lists, and instruction files keep working.
   The teaching layer is host-plane, so it also reaches agents composed from an agent preset (verified by the integration test).

## Install

```sh
dsh plugin --profile web add file:/path/to/dsh-nushell-only
# or: dsh plugin --profile web add dsh-nushell-only
```

Restart the profile afterwards. `dsh plugin` records the package in `dsh.profile.bundles` (this package declares `dsh.bundle.patch`), and the bundle patch inserts both rows into the composed tree.

> **Remove an older `dsh-nushell` first.** Exactly one provider may register `ctx.shell`; a leftover shell bundle makes boot fail on a duplicate service:
>
> ```sh
> dsh plugin --profile web remove dsh-nushell
> ```

Verify:

```sh
dsh --profile web --dump-config | grep -n "nushell"
# expect: bash-sandbox / pwsh-sandbox disabled, nushell-executor, nushell-teaching
```

## Configuration

Channel budgets, the guard, and the teaching layer are all composition config:

```yaml
- id: nushell-executor
  name: dsh-nushell-only/executor
  config:
    timeoutMs: 60000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    graceMs: 3000
    enforceNushellOnly: true
    requireNu: true
    verifyNu: true

- id: nushell-teaching
  name: dsh-nushell-only/teaching
  config:
    guide: full          # full | compact | off
    rules: true
    rewriteToolDescriptions: true
```

| Executor field | Default | Meaning |
|---|---|---|
| `nuPath` | `$DSH_NU_PATH`, else `nu` | Nushell executable: field, then environment, then PATH |
| `nuArgs` | `['--no-config-file','-c']` | Argv prefix; the command is appended last |
| `enforceNushellOnly` | `true` | The foreign-shell guard |
| `foreignShellAllowlist` | `[]` | Whole-command regex strings exempt from the guard |
| `requireNu` | `true` | Fail boot when `nu` cannot be resolved |
| `verifyNu` / `verifyTimeoutMs` | `true` / `10000` | Probe `nu --version` once at boot |

`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, and `graceMs` keep dsh's shared `shell` settings namespace, so the `shell:` section of `settings.yaml` still layers at runtime. Override any row by id in the profile's own `cordis.patch.yml`.

## What "only Nushell" does not cover

The plugin guarantees that everything through `ctx.shell` is Nushell. These bypasses are out of its reach:

1. **Preset rows that spawn their own shell.** A preset can mount a tool that calls `ctx.subprocess.spawn(['bash.exe', '-c', …])` directly (the `liangshen` preset's `custom-bash.mjs` on Windows, or a PTY `persistent-shell` group). Those never reach `ctx.shell`; the plugin neither replaces their execution nor rewrites their description (the rewrite only touches tools that claim `bash -c` / `pwsh -Command`, so it never lies about them). Disable such rows in the preset to get a Nu-only deployment.
2. **Nested handoffs.** `nu -c 'bash -c "…"'` hides the foreign shell inside a string argument; the guard deliberately does not parse string contents. It blocks explicit escapes, it is not a sandbox.
3. **Hook commands.** `dsh-hooks-claude-code` / `dsh-hooks-codex` run hooks through `ctx.shell`, so they now run Nushell: bash-syntax hooks fail. Rewrite them, relax the guard, or disable the hook bridge.
4. **The TUI's persistent PTY shell** (`dsh-terminal-bash` + `dsh-tool-bash-persistent`) uses the terminal seam, not `ctx.shell`. Point its `shellPath` at `nu` (readiness falls back to output-silence inference; not verified in this package) or use the one-shot tool.

Sandboxing is unchanged: `danger-full-access` runs directly, confined modes still wrap the Nushell argv through `ctx.sandbox.confine()` and report `mode` / `denied` / `enforcement` facts (verified on the Windows ACL chain and POSIX wrap).

## Development

```sh
node --test test/                 # 36 unit tests (guard, guide, teaching, executor argv/sandbox paths)
node test/integration.mjs         # end to end: scratch DSH_HOME, profile install, real boot, 20 assertions
node test/integration.mjs --mode workspace-write
```

The integration test asserts the executor identity, `nu --version`, Nu builtin/table/external runs, non-zero exit reporting, the refusal, the prompt sections, the rewritten descriptions (including inside a **preset-scoped** assembly), and the sandbox facts. Point it at any CLI with `DSH_INTEGRATION_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js`.

`node dev/link-peers.mjs` links the `@deepseek-ai/*` peers out of a local dsh install for a checkout-based test run.

## License

MIT.
