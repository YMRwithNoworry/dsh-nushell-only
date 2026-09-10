# dsh-nushell-only

[English](README.en.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**唯一 shell 换成 Nushell**，并**教会模型写 Nushell 语法**的 Profile Bundle。

适配版本：**dsh `0.1.5-rc.2`**（在 `0.1.5-rc.2` 与 `0.1.5-rc.1` CLI + `0.1.5-rc.2` 库上实测通过）。运行时要求 Node `>=22.19.0`、[Nushell](https://www.nushell.sh/)（实测 `0.115.1`，建议 `>=0.100`）。

## 它做了什么

一个插件、三件事，互相配合：

1. **接管 `ctx.shell`（执行层）**
   `bash-sandbox` / `pwsh-sandbox` 两个第一方执行器被禁用，换成 `dsh-nushell-only/executor`：所有 shell 执行一律变成
   `nu --no-config-file -c "<command>"`。
   因为换的是**能力接缝**（capability seam）而不是模型工具，所以 dsh 里所有走 `ctx.shell` 的消费者都会用 Nushell：模型工具、后台任务（`run_in_background`）、hook 桥（`dsh-hooks-*`）、`tmux-context`、以及任何进程内插件调用。超时、输出上限、spill 文件、后台句柄、取消、沙箱策略与拒绝事实全部沿用第一方实现（继承 `SandboxBashExecutor` / `SandboxPwshExecutor`，只替换 argv）。
   同时 `--no-config-file` 保证用户自己的 `config.nu` / `env.nu` 不会影响工具调用结果。

2. **拒绝"换个 shell 跑"（强制层）**
   执行器里带一个窄口径守卫：命令若在语句开头把执行权交给别的 shell（`bash -c`、`sh -c`、`cmd /c`、`pwsh -Command`、`wsl …`，含 `sudo` / `env` / `busybox` 包装与 `^bash`、路径形式），直接以清晰的错误拒绝，并给出 Nushell 写法对照——而不是让模型收到一个看不懂的 Nu 解析错误。默认开启，可用 `enforceNushellOnly: false` 关闭，或用 `foreignShellAllowlist` 给个别调用点开白名单。

3. **教学层（提示词层）**
   - `shell: nushell-rules`：强制规则（方言、每次调用全新进程、`workdir`、不许换 shell、数据是结构化的）。
   - `shell: nushell-guide`：语法手册 + bash/PowerShell → Nushell 对照表 + 常见坑；每次装配时求值，因此会带上探测到的 Nushell 版本号。
   - 把模型看到的 `bash` / `pwsh` 工具描述与 `command` 参数说明改写成 Nushell 方言（工具**名字**保持不变，避免破坏 preset、`toolOrder`、AGENTS.md 等对工具名的引用）。
   教学层注册在**宿主平面**：即使 web 模式的 shell 工具来自 agent preset（独立 scope），描述重写与手册依然生效（已由集成测试验证）。

## 安装

```sh
# 用本目录（或 npm 包名 / git 地址）安装进某个 profile
dsh plugin --profile web add file:/path/to/dsh-nushell-only
# 或： dsh plugin --profile web add dsh-nushell-only
```

安装后**重启该 profile**。`dsh plugin` 会把包登记进 `dsh.profile.bundles`（本包声明了 `dsh.bundle.patch`），补丁层会把上面两行插进组合树。

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
| `foreignShellAllowlist` | `[]` | 整条命令匹配的正则（字符串），命中则放行 |
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
- 对照表：`&&`、`$VAR`、`export`、`$(...)`、`a > f`、`cat|grep`、`head/tail/wc`、`sed -n`、`find`、`xargs`、`rm -rf`… 的 Nushell 写法。
- 坑：空匹配的 `ls **/*.md` 会报错（用 `glob`）、`>` 是比较不是重定向、`open` 可能返回结构化文本、内建命令会遮蔽同名外部程序、`sort-by` 需要列名、大小/时长是有类型的值。

手册里的每个 `nu` 代码块都会被 `test/guide.test.mjs` 用**本机真实的 nu** 跑一遍，所以例子不是"看起来对"，而是跑得通。

## 开发与验证

```sh
node --test test/                 # 36 个单元测试（守卫 / 手册 / 教学层 / 执行器 argv 与沙箱路径）
node test/integration.mjs         # 端到端：建临时 DSH_HOME、装 profile、真实启动、20 项断言
node test/integration.mjs --mode workspace-write   # 受限沙箱模式下再跑一遍
```

集成测试会依次验证：`ctx.shell` 就是 NushellExecutor、`nu --version`、Nu 内建管道、表管道、外部命令、非零退出以结果上报、外部 shell handoff 被拒、系统提示含规则/手册/对照表、`bash`/`pwsh` 描述与参数说明已改写、**preset 子 scope 里的 shell 工具同样被改写**、沙箱事实正确上报。可用 `DSH_INTEGRATION_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js` 指定要驱动的 CLI。

`node dev/link-peers.mjs` 把本机的 dsh 安装里的 `@deepseek-ai/*` 软链到 `node_modules/`，供 checkout 直接跑测试（正式安装由 pnpm + dsh 自身的模块回退负责）。

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `cannot resolve the Nushell executable` | 装 Nushell / 把 `nu` 加进 PATH / 设 `nuPath` 或 `DSH_NU_PATH`；临时先跑可设 `requireNu: false` |
| 启动报 `failed its --version probe` | `nu` 不可执行或损坏；`verifyNu: false` 可跳过探测 |
| 启动报重复注册 `shell` 服务 | 还有别的 shell 执行器 bundle（如 `dsh-nushell`）没卸掉 |
| 工具调用报 `Nushell-only shell: refusing …` | 模型在写别的 shell；让它按错误提示改写成 Nushell，或确有需要时用 `foreignShellAllowlist` |
| 模型仍写 bash | 检查 `guide: full`、`rewriteToolDescriptions: true`；再看模型侧 `toolOrder`/preset 是否把 shell 工具换成了自建工具 |

## 许可

MIT。
