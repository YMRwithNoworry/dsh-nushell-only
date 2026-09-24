# dsh-nushell-only

English | [中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) profile bundle that makes **Nushell the harness's only shell** and **teaches the model to write it**.

Targets **dsh `0.1.7-rc.1`** (verified against `0.1.7-rc.1` CLI and packages). Requires Node `>=22.19.0` and [Nushell](https://www.nushell.sh/) (verified with `0.115.1`; `>=0.100` recommended).

> **Upgrading from 0.2.x:** dsh `0.1.7-rc.1` collapsed the `ctx.shell` seam onto **one** execution verb, `execute(spec)` (a live handle plus the foreground projection `result()`); `run` / `start` / `runArgv` / `startArgv` are gone. `0.3.0` of this plugin implements that seam; `0.2.x` only fits `0.1.5-rc.2`.

## What it does

Three cooperating pieces:

1. **Owns `ctx.shell` (execution).** The two first-party executors (`bash-sandbox`, `pwsh-sandbox`) are disabled and replaced by `dsh-nushell-only/executor`, so every shell command becomes
   `nu --no-config-file -c "<command>"`.
   Because the replacement is at the capability seam rather than at the model tool, *every* `ctx.shell` consumer runs Nushell: the model tools, background jobs, the hook bridges (`dsh-hooks-*`), `tmux-context`, and any in-process caller. Timeouts, output caps, spill files, background handles, cancellation, the sandbox wrap, and its denial/runner-failure facts all stay the first-party implementation (the executor extends `SandboxBashExecutor` / `SandboxPwshExecutor` and replaces only the argv).
   Exactly three seams are overridden: `execute(spec)` (the single entry point — the `danger-full-access` branch is rebuilt there while the confined branch delegates to the base executor), `argv(spec)` (the PowerShell family's argv seam), and `confine(subject, policy, signal)` (the POSIX family passes the command string, the Windows family the resolved spec; both are accepted, and `signal` is forwarded to `ctx.sandbox` unchanged).
   `--no-config-file` keeps the user's `config.nu` / `env.nu` from changing what a tool call does.

2. **Refuses "hand it to another shell" (enforcement).** A narrow guard rejects a command whose statement starts by delegating to another shell (`bash -c`, `sh -c`, `cmd /c`, `pwsh -Command`, `wsl …`, including `sudo`/`env`/`busybox` wrappers, `^bash`, and path forms) with an actionable error and a Nushell translation, instead of letting the model hit an opaque Nu parse error. On by default; `enforceNushellOnly: false` disables it, `foreignShellAllowlist` exempts individual call sites.

3. **Teaching layer (prompt).**
   - `shell: nushell-rules` — the mandatory rules: dialect, fresh process per call, `workdir` instead of `cd`, no shell fallback, structured pipelines.
   - `shell: nushell-guide` — syntax, a bash/PowerShell → Nushell translation table, and the traps; evaluated per assembly so it carries the probed Nushell version.
   - Rewrites the model-facing `bash` / `pwsh` tool descriptions and their `command` parameter into the Nushell dialect. The tool **names** stay the same so presets, `toolOrder` lists, and instruction files keep working.
   The teaching layer is host-plane, so it also reaches agents composed from an agent preset (verified by the integration test).

4. **Dialect preflight and failure hints (correction).** Owning `ctx.shell` is not enough: the model still writes commands that are valid bash or PowerShell, are *not* a shell handoff, and therefore reach `nu` — `2>&1`, `2>$null`, `$env:VAR`, `$x = 1`, `foreach`, `@(…)`, `Get-Content`, `glob a b`, `mkdir -p`, `select name, type`, and friends. Most of them die as a parse error; `2>$null` / `2>/dev/null` / `2>nul` / `2>>f` do something worse — Nushell 0.115.1 lexes them as ordinary words, so the program receives an extra argument and stderr is never suppressed. Silent misbehaviour is worth refusing precisely because it does not fail.
   The preflight refuses them **before spawning** and puts the offending fragment, the whole command, and the Nushell spelling in the error text (`2>&1` → `o+e>`, `2>$null` → `e> nul` or `| complete`, `$x = 1` → `let x = 1`, `Get-ChildItem` → `ls`, `select name, type` → `select name type`). Strings, raw strings, and comments are blanked first — at Nushell's real comment boundaries, so `;# note 2>&1`, `{# 2>&1`, and `| # 2>&1` are data — which keeps `print "a && b"`, `open --raw 'p?ath'`, and `^Get-ChildItem` (an explicit external) safe. Cmdlets nested in `( … )` / `{ … }` (`print (Get-ChildItem -Recurse)`) are caught too. Unix tools (`grep`, `head`, `cat`) are deliberately **not** refused — on POSIX they are legitimate external programs — they only feed the "that program is not installed here" hint.
   When a call fails anyway, one `Nushell hint (…)` line is appended to stderr, chosen from the error Nushell actually reported (missing path, absent column, missing name, wrong input type, unknown flag, empty glob, unavailable external, empty pipeline, `out+err>` used as a pipeline stage, `first -3`, `-ErrorAction`, `%{ … }`, `{ a = 1 }`, …), including the trap that **a failing external command aborts the rest of the command and prints nothing at all** — measured on Nushell 0.115, and visible in transcripts as an unexplained `[exit code: 1]`.
   A spelling Nushell only *warns* about (`str downcase`, `get -i`) is **not** refused any more: blocking a command that runs wastes a turn, and the deprecation hint teaches the replacement instead.

## Why these rules: failures from real sessions

The rules are not invented. Across **109 sessions and 8168 shell calls** in this machine's `~/.dsh/sessions`, 1503 shells calls failed with a Nushell error code:

| Observed error | Count | The habit being written |
|---|---|---|
| `nu::shell::external_command` | 423 | `grep`, `head`, `cat`, `Get-Content`, `docker` (not builtins, not installed) |
| `nu::parser::unknown_flag` | 140 | `ls -a`, `ls -R`, `mkdir -p`, `select -First 20`, `head -40` |
| `nu::parser::variable_not_found` | 137 | `$x = 1`, `foreach`, `$env:REF = …` |
| `nu::shell::io::not_found` | 128 | `ls <missing>` — bash prints an error, Nushell aborts |
| `nu::parser::shell_outerr` | 85 | `2>&1`, `2> file` (the `2>$null` spelling does not even fail — see above) |
| `nu::parser::error` | 70 | `%{ … }`, `{ a = 1 }`, and other parse oddities |
| `nu::shell::column_not_found` | 53 | `$env.LAST_EXIT_CODE`, `$env.HOME` |
| `nu::shell::error` | 44 | a `glob` / `ls <glob>` that matched nothing |
| `nu::shell::incompatible_path_access` | 34 | path commands over a non-path |
| `nu::shell::only_supports_this_input_type` | 35 | `$env \| where name =~ …` (`$env` is a record) |
| `nu::parser::deprecated` | 29 | `str downcase`, `get -i`, `select -First` |
| `nu::shell::eval_block_with_input` | 28 | wrong input inside an `each` / `where` closure |
| `nu::parser::extra_positional` | 20 | `glob "**/*.java" "D:/dir"`, `each { … } [list]` |
| `nu::shell::name_not_found` | 17 | `select name, type` (a comma is not a column separator) |

Those habits live in `lib/dialect.js` as a rule table (refuse) and an error-code → hint table (hint), backed by three sources that check each other:

- `test/corpus.mjs` — the refused and the allowed commands, **each one run on the local `nu`**;
- `test/fixtures/nu-errors/` — a captured stderr per failure class (regenerate with `node dev/capture-nu-errors.mjs`), and `test/fixtures.test.mjs` fails if any captured class produces no hint;
- `test/nu-accepts.test.mjs` — the reverse check: a refused command must really fail in `nu`, and an allowed one must really run (skipped when `nu` is not on PATH).

That check has removed twelve classes of real false positive — commands `nu` runs and the plugin refused anyway:

| Wrongly refused | Example | Why it was wrong |
|---|---|---|
| A comment boundary judged too narrowly | `print 1;# note about 2>&1` | `#` opens a comment at a token boundary, including `;#`, `{#`, `(#`, `[#`, `\|#` |
| A deprecated-but-working spelling treated as fatal | `str downcase`, `get -i` | Nushell only warns and runs it; blocking a working command wastes a turn |
| A quoted string in command position | `"a=1" \| str length`, `"Get-Content" \| str length` | Nushell rejects a quoted command name (`'bash' -c 'echo hi'` is a parse mismatch), so a quoted first word is data |
| A closure parameter read as a program | `[1 2] \| each { \|sh\| $sh }`, `['git' 'node'] \| each { \|cmd\| ^$cmd --version }` | the guard splits statements on `\|`, so `{ \|sh\| … }`'s parameter looked like a handoff to `sh` |
| `&` inside a bare word | `print a&sh` | `a&sh` is one word in Nushell; `&` separates only when it stands alone |
| Raw strings unknown to the guard | `print r#'don't; sh -c x'#` | the inner `'` desynchronised the scanner, and `; sh -c x` looked like a handoff |
| `glob` counting a flag's operand as a second pattern | `glob --depth 2 **/*.txt` | the refusal text itself recommended that spelling |
| `?` at the end of a path | `open D:/x/probe1.tx?` | `?` *is* a one-character glob wildcard in Nushell (the old "not a wildcard" wording was simply wrong); the rule is gone, the hint stays |
| Typed `mut` / `let` | `mut x: int = 1; $x = 2` | the declared-name regex required `=` right after the name |
| `foreach` not anchored to command position | `^git grep -n foreach`, `glob **/foreach*` | searching for that word is ordinary work |
| Rules ignoring `^external` arguments | `^node -e '…' -- -Force`, `^node … -not` | flags after `^prog` belong to that program |
| The command-position scan hitting data or user-defined names | `let r = { get-content: 1 }`, `def get-content [] { … }; get-content` | a record key and the model's own `def` are not cmdlets |

It also added a rule for a silent misread the suite had missed (the same class as `2>$null`): a bare `>` is *comparison* in Nushell, so `cmd > out.txt` passes the operator and the filename as arguments, exits 0, and **writes no file** — `stdout-redirect` refuses that, while `where size > 1kb` and `if $n > 2 { … }` keep working.

## Install

```sh
# Install from npm (published)
dsh plugin --profile web add dsh-nushell-only

# Install directly from GitHub into a profile (to track the repo, or an unreleased commit)
dsh plugin --profile web add github:YMRwithNoworry/dsh-nushell-only

# Pin a commit for reproducibility (optional; replace <sha>)
dsh plugin --profile web add github:YMRwithNoworry/dsh-nushell-only#<sha>

# Or install a local checkout
dsh plugin --profile web add file:/path/to/dsh-nushell-only
```

Restart the profile afterwards. The package name is `dsh-nushell-only`; the npm registry copy is `0.2.0` and lags this repository (`0.4.0`, for dsh `0.1.7-rc.1`), so use the GitHub or local-checkout form below to get the current code. `dsh plugin` records the package in `dsh.profile.bundles` (this package declares `dsh.bundle.patch`), and the bundle patch inserts both rows into the composed tree.

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
    dialectLint: true       # refuse foreign-dialect habits before spawning, with the Nushell form
    dialectHints: true      # append one actionable Nushell hint to a failed call's stderr
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
| `foreignShellAllowlist` | `[]` | Whole-command regex strings exempt from the guard *and* the dialect lint |
| `dialectLint` | `true` | Refuse bash/PowerShell habits before spawning (`2>&1`, `2>$null`, `$env:VAR`, `$x = 1`, `foreach`, `@(…)`, `Get-Content`, `glob a b`, `mkdir -p`, `select name, type`, `first -3`, `%{ … }`, …), naming the fragment, the command, and the Nushell form |
| `dialectHints` | `true` | Append one `Nushell hint (…)` line to a failed call's stderr, chosen by the Nushell error (including the silent non-zero-exit abort) |
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
node --test test/                 # 58 unit tests (guard, dialect preflight/hints, hint fixtures, guide, teaching, executor argv/sandbox paths)
node dev/capture-nu-errors.mjs    # re-capture real stderr per failure class into test/fixtures/nu-errors/
node test/integration.mjs         # end to end: scratch DSH_HOME, profile install, real boot, per-check assertions
node test/integration.mjs --mode workspace-write
```

The integration test asserts the executor identity, `nu --version`, **the presence of the 0.1.7 `execute`/`resolve` seam**, Nu builtin/table/external runs, non-zero exit reporting, the foreign-shell refusal, **the dialect preflight refusing `2>&1` and `$x = 1` with the Nushell spelling**, **a failed call carrying a `Nushell hint`**, **a background handle that starts, kills, and settles as `killed`**, the prompt sections (rules, guide, translation table, failure catalogue), the rewritten descriptions (including inside a **preset-scoped** assembly), and the sandbox facts. The CLI it drives is `$DSH_INTEGRATION_CLI`, else the pinned local copy at the sibling `.verify/node_modules/@deepseek-ai/dsh/lib/bin.js` (a verification-only checkout that is not part of this repository), else the global `dsh` on PATH.

Measured local caveat: under `--mode workspace-write` on this machine, the Windows ACL restricted-token runner refuses to let a confined process spawn a **piped** child (`Could not spawn foreground child: 拒绝访问 (os error 5)`), so `^git --version | str trim` cannot run. This is **not** caused by this plugin or by Nushell: disabling `nushell-executor` and restoring the first-party `pwsh-sandbox` row inside the very same composition makes `git --version | Out-String` fail the same way (`程序'git.exe'运行失败：拒绝访问`). A bare external (`^git --version`) runs fine confined. The integration test reports the piped case as a SKIP with that reason instead of a failure, and it PASSes under `danger-full-access`.

`node dev/link-peers.mjs` links the `@deepseek-ai/*` peers out of a local dsh install for a checkout-based test run. Note that the executor's budget fields (`cwd`/`timeoutMs`/…) are schemastery `volatile` fields, so **only a schema-resolved config is serviceable**: the unit tests build theirs with `Schema.resolve(raw, NushellExecutor.Config)[0]`, the same path the plugin loader takes.

## License

MIT.
