# dsh-nushell-only

[English](README.en.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**唯一 shell 换成 Nushell**，并**教会模型写 Nushell 语法**的 Profile Bundle。

适配版本：**dsh `0.1.7-rc.1`**（在 `0.1.7-rc.1` CLI + 库上实测通过）。运行时要求 Node `>=22.19.0`、[Nushell](https://www.nushell.sh/)（实测 `0.115.1`，建议 `>=0.100`）。

> **从 0.2.x 升级**：dsh `0.1.7-rc.1` 把 `ctx.shell` 接缝收敛成**一个**执行动词 `execute(spec)`（返回活句柄 + 前台投影 `result()`），旧的 `run` / `start` / `runArgv` / `startArgv` 已移除。本插件 `0.3.0` 即适配该接缝；`0.2.x` 只能配 `0.1.5-rc.2` 使用。

## 它做了什么

一个插件、三件事，互相配合：

1. **接管 `ctx.shell`（执行层）**
   `bash-sandbox` / `pwsh-sandbox` 两个第一方执行器被禁用，换成 `dsh-nushell-only/executor`：所有 shell 执行一律变成
   `nu --no-config-file -c "<command>"`。
   因为换的是**能力接缝**（capability seam）而不是模型工具，所以 dsh 里所有走 `ctx.shell` 的消费者都会用 Nushell：模型工具、后台任务（`run_in_background`）、hook 桥（`dsh-hooks-*`）、`tmux-context`、以及任何进程内插件调用。超时、输出上限、spill 文件、后台句柄、取消、沙箱策略与拒绝事实全部沿用第一方实现（继承 `SandboxBashExecutor` / `SandboxPwshExecutor`，只替换 argv）。
   具体只覆盖三个接缝：`execute(spec)`（唯一入口；`danger-full-access` 分支在此重建，受限分支委托给基类）、`argv(spec)`（PowerShell 族的 argv 接缝）、`confine(subject, policy, signal)`（POSIX 族传命令字符串、Windows 族传 spec，两者都接受，并把 `signal` 原样转给 `ctx.sandbox`）。
   同时 `--no-config-file` 保证用户自己的 `config.nu` / `env.nu` 不会影响工具调用结果。

2. **拒绝"换个 shell 跑"（强制层）**
   执行器里带一个窄口径守卫：命令若在语句开头把执行权交给别的 shell（`bash -c`、`sh -c`、`cmd /c`、`pwsh -Command`、`wsl …`，含 `sudo` / `env` / `busybox` 包装与 `^bash`、路径形式），直接以清晰的错误拒绝，并给出 Nushell 写法对照——而不是让模型收到一个看不懂的 Nu 解析错误。默认开启，可用 `enforceNushellOnly: false` 关闭，或用 `foreignShellAllowlist` 给个别调用点开白名单。

3. **教学层（提示词层）**
   - `shell: nushell-rules`：强制规则（方言、每次调用全新进程、`workdir`、不许换 shell、数据是结构化的）。
   - `shell: nushell-guide`：语法手册 + bash/PowerShell → Nushell 对照表 + 常见坑；每次装配时求值，因此会带上探测到的 Nushell 版本号。
   - 把模型看到的 `bash` / `pwsh` 工具描述与 `command` 参数说明改写成 Nushell 方言（工具**名字**保持不变，避免破坏 preset、`toolOrder`、AGENTS.md 等对工具名的引用）。
   教学层注册在**宿主平面**：即使 web 模式的 shell 工具来自 agent preset（独立 scope），描述重写与手册依然生效（已由集成测试验证）。

4. **方言预检 + 失败提示（纠错层）**
   光"唯一 shell 是 Nushell"还不够：模型会习惯性写出**语法上属于 bash/PowerShell、但不是换 shell** 的命令（`2>&1`、`2>$null`、`$env:VAR`、`$x = 1`、`foreach`、`@(…)`、`Get-Content`、`glob a b`、`mkdir -p`、`select name, type`…）。其中大多数会砸在 `nu` 的解析器上；而 `2>$null` / `2>/dev/null` / `2>nul` / `2>>f` **连错都不报**——Nushell 把它们当作普通单词，于是程序多收到一个参数、stderr 根本没被丢弃（本机 0.115.1 实测）。这类"静默做错"比报错更值得拦。
   预检层在 spawn 之前就拒掉它们，错误文本里给出**错误片段、整条命令、以及 Nu 写法**（`2>&1` → `o+e>`；`2>$null` → `e> nul` 或 `| complete`；`$x = 1` → `let x = 1`；`Get-ChildItem` → `ls`；`select name, type` → `select name type` …）。字符串、raw string、注释先按 Nushell 真实规则遮蔽（注释在 token 边界开始，`;# note 2>&1`、`{# 2>&1`、`| # 2>&1` 都算注释），所以 `print "a && b"`、`open --raw 'p?ath'`、`^Get-ChildItem`（显式外部）都不会被误判；Unix 工具（`grep`/`head`/`cat`）**不**在拒绝之列——它们在 POSIX 上是合法外部程序，只在"本机没有这个程序"时通过提示给出 Nu 写法。嵌套在 `( … )` / `{ … }` 里的 cmdlet（`print (Get-ChildItem -Recurse)`）同样会被抓到。
   执行失败时，stderr 末尾追加一行 `Nushell hint (…)`，按 `nu` 实际报的错误码给出对应修法（路径不存在、列不存在、名字不存在、输入类型不匹配、未知 flag、`glob` 无匹配、外部命令不存在、空管道、`out+err>` 当管道用、`first -3`、`-ErrorAction`、`%{ … }`、`{ a = 1 }`…），其中也包括"**外部命令非零退出会中断整条命令、且什么都不打印**"——本机 Nushell 0.115 实测如此，会话日志里表现为莫名其妙的 `[exit code: 1]`。
   **只警告、仍能跑的过时写法**（`str downcase`、`get -i`）不再被拒——挡下能跑的命令等于白费一轮；它们由 deprecation 提示负责教学。

## 为什么要这些规则：来自真实会话的失败数据

本插件的规则不是想出来的。下表统计了本机 `~/.dsh/sessions` 里 **109 个会话、8168 次 shell 调用**中带 Nushell 错误码的 1503 次失败：

| 观察到的错误 | 次数 | 模型当时写的习惯 |
|---|---|---|
| `nu::shell::external_command` | 423 | `grep`、`head`、`cat`、`Get-Content`、`docker`（非 Nu 内建、本机也不存在） |
| `nu::parser::unknown_flag` | 140 | `ls -a`、`ls -R`、`mkdir -p`、`select -First 20`、`head -40` |
| `nu::parser::variable_not_found` | 137 | `$x = 1`、`foreach`、`$env:REF = …` |
| `nu::shell::io::not_found` | 128 | `ls <不存在的路径>`（bash 里只打印错误，Nu 里中断） |
| `nu::parser::shell_outerr` | 85 | `2>&1`、`2> file`（`2>$null` 那类不报错，见上一节） |
| `nu::parser::error` | 70 | `%{ … }`、`{ a = 1 }`、`ls -a "…\x"` 之类的杂项解析错 |
| `nu::shell::column_not_found` | 53 | `$env.LAST_EXIT_CODE`、`$env.HOME` |
| `nu::shell::error` | 44 | `glob` / `ls <glob>` 一个都没匹配到 |
| `nu::shell::incompatible_path_access` | 34 | 把非路径丢给 path 命令 |
| `nu::shell::only_supports_this_input_type` | 35 | `$env \| where name =~ …`（`$env` 是 record） |
| `nu::parser::deprecated` | 29 | `str downcase`、`get -i`、`select -First` |
| `nu::shell::eval_block_with_input` | 28 | `each` / `where` 闭包里用错输入 |
| `nu::parser::extra_positional` | 20 | `glob "**/*.java" "D:/dir"`、`each { … } [list]` |
| `nu::shell::name_not_found` | 17 | `select name, type`（逗号在 Nu 里不是列分隔符） |

这些习惯被固化成两层：`lib/dialect.js` 的规则表（refuse）与错误码→提示表（hint）。三份证据互相咬合：

- `test/corpus.mjs`：refusal / allowed 两组命令，**每条都在本机 `nu` 上跑过**；
- `test/fixtures/nu-errors/`：每个失败类一份**真实 stderr 抓取**（`node dev/capture-nu-errors.mjs` 可重新生成），`test/fixtures.test.mjs` 断言每个被抓到的失败类**都必须产出提示**；
- `test/nu-accepts.test.mjs`：反向对照——被拒的命令必须真的在 `nu` 里失败，被放行的命令必须真的能跑（`nu` 不在 PATH 时整体跳过）。

上一版还因此修掉三类真实误判：`;# 2>&1` 这类注释被当成重定向；能跑通的 `str downcase` / `get -i` 被当成硬错误拦下；以及**命令位置上被引号包起来的字符串**（`"a=1" | str length`、`"Get-Content" | str length`）被当成 bash 的 `VAR=value` 前缀或 PowerShell cmdlet——Nushell 本身不接受"带引号的命令名"（`'bash' -c 'echo hi'` 是 `parse_mismatch`），所以那种位置的引号内容一律是数据。

## 安装

```sh
# 从 npm 安装（已发布）
dsh plugin --profile web add dsh-nushell-only

# 从 GitHub 直接安装进某个 profile（想跟仓库走，或需要未发布的提交）
dsh plugin --profile web add github:YMRwithNoworry/dsh-nushell-only

# 锁定提交可复现（可选；把 <sha> 换成 README 所在提交）
dsh plugin --profile web add github:YMRwithNoworry/dsh-nushell-only#<sha>

# 或安装本地 checkout
dsh plugin --profile web add file:/path/to/dsh-nushell-only
```

安装后**重启该 profile**。包名 `dsh-nushell-only`（npm registry 上是 `0.2.0`，比本仓库旧；想要最新代码就用下面的 GitHub 或本地 checkout 形式）。本仓库为 `0.4.0`，适配 dsh `0.1.7-rc.1`。`dsh plugin` 会把包登记进 `dsh.profile.bundles`（本包声明了 `dsh.bundle.patch`），补丁层会把上面两行插进组合树。

> **先卸掉旧的 `dsh-nushell`**：一个上下文只允许一个 `ctx.shell` 提供者。如果 profile 里已经有 `dsh-nushell`（或任何其他 shell 执行器 bundle），请先：
>
> ```sh
> dsh plugin --profile web remove dsh-nushell
> ```
>
> 否则启动时会因重复注册 `shell` 服务而失败。

验证：

```sh
dsh --profile web --dump-config | grep -n "nushell"
# 期望看到：bash-sandbox / pwsh-sandbox = disabled，以及 nushell-executor、nushell-teaching 两行
```

## 配置

补丁层默认配置（`cordis.patch.yml`）：

```yaml
- id: nushell-executor
  name: dsh-nushell-only/executor
  config:
    timeoutMs: 60000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    graceMs: 3000
    enforceNushellOnly: true   # 拒绝把命令交给别的 shell
    dialectLint: true          # spawn 前拒绝 bash/PowerShell 习惯，并给出 Nu 写法
    dialectHints: true         # 失败时按 nu 错误码追加一行 Nushell hint
    requireNu: true            # 找不到 nu 就启动失败（而不是每次调用都失败）
    verifyNu: true             # 启动时跑一次 `nu --version`

- id: nushell-teaching
  name: dsh-nushell-only/teaching
  config:
    guide: full                # full | compact | off
    rules: true
    rewriteToolDescriptions: true
```

执行器可选项：

| 字段 | 默认 | 含义 |
|---|---|---|
| `nuPath` | `$DSH_NU_PATH` → `nu` | Nushell 可执行文件；优先级：本字段 > 环境变量 > PATH |
| `nuArgs` | `['--no-config-file','-c']` | argv 前缀，命令追加在最后 |
| `enforceNushellOnly` | `true` | 守卫开关 |
| `foreignShellAllowlist` | `[]` | 整条命令匹配的正则（字符串），命中则放行（守卫与方言预检共用） |
| `dialectLint` | `true` | spawn 前拒掉 bash/PowerShell 习惯（`2>&1`、`2>$null`、`$env:VAR`、`$x = 1`、`foreach`、`@(…)`、`Get-Content`、`glob a b`、`mkdir -p`、`select name, type`、`first -3`、`%{ … }`…），错误里给出片段、整条命令与 Nu 写法 |
| `dialectHints` | `true` | 失败时在 stderr 末尾追加一行 `Nushell hint (…)`，按 `nu` 错误码给修法（含静默非零退出的中断语义） |
| `requireNu` | `true` | 无法解析 `nu` 时启动即失败 |
| `verifyNu` / `verifyTimeoutMs` | `true` / `10000` | 启动探测 `nu --version` 及其超时 |

`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs` 沿用 dsh 自己的 `shell` 设置命名空间，`settings.yaml` 的 `shell:` 段仍然可以热改预算。

在本 profile 的 `cordis.patch.yml` 里按 id 覆盖即可，例如：

```yaml
- id: nushell-executor
  config:
    nuPath: 'C:\Users\me\AppData\Local\Programs\nu\bin\nu.exe'
    enforceNushellOnly: false
```

## "只用 Nushell" 的边界

插件能保证的是**经过 `ctx.shell` 的一切**都是 Nushell。以下情况它管不到，README 明说，避免误判：

1. **preset 里自己 spawn shell 的行**。例如本机 `~/.dsh/.agent-presets/liangshen/agent.cordis.yml` 的 `custom-bash.mjs`（Windows 上直接 `ctx.subprocess.spawn(['bash.exe','-c',...])`）与 `persistent-shell` 组（PTY 常驻 bash）。这类工具绕开 `ctx.shell`，插件既无法改写它的执行，也不会改写它的描述（描述重写只针对自称 `bash -c` / `pwsh -Command` 的第一方工具，以免说谎）。要用 Nu-only，请在这些 preset 文件里把对应行 `disabled: true`（Windows 上 `tool-pwsh` 会通过 `ctx.shell` 变成 Nu，可以顶上），或把 `persistent-shell` 组整体禁用。
2. **嵌套调用**。`nu -c 'bash -c "..."'` 里层是字符串参数，守卫按设计不看字符串内部；`nu` 当然也能启动别的程序。守卫挡的是"模型想绕过 Nu"这类显式 handoff，不是沙箱。
3. **`dsh-hooks-claude-code` / `dsh-hooks-codex` 的 hook 命令**。它们通过 `ctx.shell` 执行，现在就是 Nushell：**为 bash 写的 hook（`&&`、`$VAR`、`export`）会失败**。要么把 hook 改写成 Nushell，要么给执行器关掉守卫/把 profile 里的 hook 桥禁用。
4. **TUI 的常驻 PTY shell**（`dsh-terminal-bash` + `dsh-tool-bash-persistent`）走的是 terminal 接缝，不是 `ctx.shell`，插件不替换它。需要常驻 Nu 会话时目前只能自行把这两行换成 `dsh-terminal-bash` 的 `shellPath: nu` 变体（readiness 会退化为"输出静默推断"，未在本包内验证），或者改用一次性工具。

沙箱与权限不变：`danger-full-access` 直接执行，受限模式仍然经 `ctx.sandbox.confine()` 包裹 Nu 的 argv，并照常上报 `mode` / `denied` / `enforcement` 事实（Windows ACL 链与 POSIX 链接口均已实测包裹成功）。

## 教学层给了模型什么

`guide: full` 时，系统提示里会出现（顺序紧贴 shell 工具引导位）：

- 规则段：方言是 Nushell、每次调用全新进程（`cd`/`let`/`$env` 不保留，用 `workdir`）、不加载 `config.nu`、换 shell 会被拒、管道里是结构化数据、`open --raw` 读文本。
- 语法手册：`let`/`mut`/`$env`/插值/`if`/`match`/`def`/`try`/`for`；表与列表（`where`/`select`/`get`/`sort-by`/`each`/`group-by`）；外部命令（`^git`、`complete`、退出码）；文本处理（`split row`/`parse`/`lines`/`str *`）；路径与环境（`path *`、`$nu.*`、单引号与转义）。
- 对照表：`&&`、`$VAR`、`$x = 1`、`export`、`$(...)`、`@(…)`、`foreach`、`a > f`、`2>&1`、`2>$null`（不是重定向，是普通单词）、`cat|grep`、`head/tail/wc`、`sed -n`、`find`、`xargs`、`select -First`、`get -i`、`select a, b`、`first -3`、`| out+err>`、`%{ … }`、`-ErrorAction`、`glob a b`、`$env.LAST_EXIT_CODE`、`rm -rf`… 的 Nushell 写法。
- 失败目录（`When Nushell refuses`）：把上表的真实错误码 → 原因 → 写法做成对照表，附一段可运行的"正确写法"示例。
- 坑：空匹配的 `ls **/*.md` 会报错（用 `glob`）、`>` 是比较不是重定向、重定向不能当管道用（`cmd | o> f` 什么都没重定向）、逗号只分隔列表字面量（`[1, 2]` 可以，`select a, b` 不行）、`#` 在 token 边界才开始注释、`open` 可能返回结构化文本、内建命令会遮蔽同名外部程序、`sort-by` 需要列名、大小/时长是有类型的值；另外还有两条本机 0.115 实测的语义：**外部命令非零退出会中断整条命令且不打印原因**、**`nu -c` 只显示最后一条语句的值**（中间结果要 `print`）。

手册里的每个 `nu` 代码块都会被 `test/guide.test.mjs` 用**本机真实的 nu** 跑一遍，所以例子不是"看起来对"，而是跑得通。

## 开发与验证

```sh
node --test test/                 # 58 个单元测试（守卫 / 方言预检与提示 / 提示覆盖夹具 / 手册 / 教学层 / 执行器 argv 与沙箱路径）
node dev/capture-nu-errors.mjs    # 重新抓取每个失败类的真实 stderr（写入 test/fixtures/nu-errors/）
node test/integration.mjs         # 端到端：建临时 DSH_HOME、装 profile、真实启动、逐项断言
node test/integration.mjs --mode workspace-write   # 受限沙箱模式下再跑一遍
```

集成测试会依次验证：`ctx.shell` 就是 NushellExecutor、`nu --version`、**0.1.7 的 `execute`/`resolve` 接缝存在**、Nu 内建管道、表管道、外部命令、非零退出以结果上报、外部 shell handoff 被拒、**方言预检拒绝 `2>&1` 与 `$x = 1` 并给出 Nu 写法**、**失败调用带回 `Nushell hint`**、**后台句柄可以起来并被 kill、settle 为 `killed`**、系统提示含规则/手册/对照表/失败目录、`bash`/`pwsh` 描述与参数说明已改写、**preset 子 scope 里的 shell 工具同样被改写**、沙箱事实正确上报。它驱动的 CLI 依次取：`$DSH_INTEGRATION_CLI` → 仓库旁的 `.verify/node_modules/@deepseek-ai/dsh/lib/bin.js`（本地验证用的锁定副本，未纳入本仓库）→ PATH 上的全局 `dsh`。

`node dev/link-peers.mjs` 把本机的 dsh 安装里的 `@deepseek-ai/*` 软链到 `node_modules/`，供 checkout 直接跑测试（正式安装由 pnpm + dsh 自身的模块回退负责）。注意执行器的预算字段（`cwd`/`timeoutMs`/…）在 dsh 里是 schemastery 的 `volatile` 字段，**只有经过 schema 解析的 config 才可用**——单测因此用 `Schema.resolve(raw, NushellExecutor.Config)[0]` 构造配置，和生产加载路径一致。

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `cannot resolve the Nushell executable` | 装 Nushell / 把 `nu` 加进 PATH / 设 `nuPath` 或 `DSH_NU_PATH`；临时先跑可设 `requireNu: false` |
| 启动报 `failed its --version probe` | `nu` 不可执行或损坏；`verifyNu: false` 可跳过探测 |
| 启动报重复注册 `shell` 服务 | 还有别的 shell 执行器 bundle（如 `dsh-nushell`）没卸掉 |
| 工具调用报 `Nushell-only shell: refusing …` | 模型在写别的 shell 或 bash/PowerShell 语法；错误里已给出片段、整条命令与 Nu 写法，让它改完再调；确有需要时用 `foreignShellAllowlist` / `dialectLint: false` |
| 工具调用报"refusing a … command"，但命令其实是合法 Nu | 误判了：直接引用整条命令写进 `foreignShellAllowlist`；`lib/dialect.js` 的规则都带 id，便于定位；并把该命令补进 `test/corpus.mjs` 的 `ALLOWED`，`test/nu-accepts.test.mjs` 会在本机 `nu` 上把它跑一遍 |
| 某个 Nushell 报错没有 `Nushell hint` | 该错误类还没进提示表：在 `dev/capture-nu-errors.mjs` 里加一条能复现的命令、重跑抓取，`test/fixtures.test.mjs` 会直接点名缺失的失败类 |
| hint 文案对不上真实报错 | 提示正则按"记忆里的报错"写的就会这样（`No matches found for Expand` 实为 `DoNotExpand`）：重新抓夹具，再改 `lib/dialect.js` 的 `HINTS` |
| 调用返回 `[exit code: N]` 却没有任何输出 | 外部命令非零退出会中断整条命令且不打印原因；让模型按 hint 改用 `\| complete` / `do -i` / `try`，或直接看 `Nushell hint (silent-exit)` |
| 中间语句的结果"看不到" | `nu -c` 只显示最后一条语句的值；要 `print` 或用 `to json` 输出 |
| `workspace-write` 下"把外部命令管道进 Nu 内建"被 SKIP | 本机 Windows ACL restricted-token runner **拒绝被限制进程再 spawn 带管道的子进程**（`Could not spawn foreground child: 拒绝访问 (os error 5)`）。已实测与本插件无关：同一组合里把 `nushell-executor` 禁用、恢复第一方 `pwsh-sandbox`，`git --version \| Out-String` 同样报"程序'git.exe'运行失败：拒绝访问"。裸外部命令（`^git --version`）在受限模式下正常。集成测试遇到这种环境记为 SKIP 而不是 FAIL；`--mode danger-full-access` 下该项通过 |
| 模型仍写 bash | 检查 `guide: full`、`rewriteToolDescriptions: true`；再看模型侧 `toolOrder`/preset 是否把 shell 工具换成了自建工具 |

## 许可

MIT。
