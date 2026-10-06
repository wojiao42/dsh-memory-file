# dsh-memory-file

给 DeepSeek Harness 的**文件型长期记忆**：每个会话开始注入你自己的 Markdown 记忆文件，并提供工具让 agent 读写它、把拿不准的放进待审队列、撤回写错的一条，以及核对它到底读过什么。

**这个插件的核心卖点不是功能，是可核实性。** 单文件、无构建、无第三方依赖：`index.js` 约 870 行（含注释与说明），读完大约十分钟，你就能自己确认它做了什么。
从 v1.1.0 起还多了一层机制：**任何敏感操作（列目录、复制文件、读会话日志）都必须在调用处逐个登记用途，`smoke.mjs` 会核对登记数量与实际调用数量** —— 偷偷加一处，自测立刻变红。

**它默认不读你的对话。** 只有你显式打开 `autoScan` 之后，才会读本机 `$DSH_HOME/sessions/` 下的会话日志，用来提示 agent"有新的持久事实可记"（v1.2.0 新增，见「autoScan」一节）。

---

## 它不做什么（这是设计约束，可对照源码逐条核实）

| 主张 | 怎么自己核实 |
|---|---|
| **不读 `messages`** | 全文唯一的订阅是 `ctx.on('agent/pre-step')`，且回调参数里**没有解构 `messages`**（`{ agent, step, signal }`）。搜索 `ctx.on(` 只有一处。 |
| **默认不读会话日志** | `autoScan` 的默认值是 `false`（源码里 `const DEFAULT_AUTO_SCAN = false;`），扫描调用被 `if (autoScan)` 包住并整段 `try/catch`。`smoke.mjs` 有专门断言核对这两点，还有一条断言跑真实注入验证"关闭时日志内容一个字都不出现"。 |
| **开着 autoScan 时也只读不写** | 会话日志只用 `readFileSync` 读取，不复制、不上传、不修改；读取点用 `[audit:sessions]` 登记，且有单文件 8MB / 单轮 32MB 上限。 |
| **不联网** | 全文没有 `fetch` / `http` / `https` / `net` / `dns` / `tls` / WebSocket。检查 `import` 语句：只有 `node:fs`、`node:os`、`node:path`、`node:zlib`（解压会话日志用），加两个 DSH 官方包。 |
| **不执行命令** | 没有 `child_process`，也没有 `spawn` / `execSync`。 |
| **不删、不改名、不改权限** | 没有 `rmSync` / `unlinkSync` / `renameSync` / `chmodSync` / `rmdirSync`。（待审条目「丢弃」只是改标记 `- [-]`，不删文件。） |
| **只碰记忆文件附近的那几个位置** | 全部路径由 `resolveMemoryPaths()` + `sidecarPaths(memoryFile)` 推导，不接受任何外部传入的路径。见下节。 |
| **敏感操作逐个登记** | `readdirSync` / `copyFileSync` 每次调用，上一行必须有 `[audit:readdir]` / `[audit:copy]` 说明；`smoke.mjs` 断言登记数 == 调用数。读会话日志另用 `[audit:sessions]` 登记。 |

### 它到底会写哪些文件

| 位置 | 内容 | 谁写 |
|---|---|---|
| `$DSH_HOME/memory/MEMORY.md` | 全局记忆 | `memory_add`（`scope: global`） |
| `<工作区>/.dsh/memory/MEMORY.md` | 工作区记忆（默认目标） | `memory_add`、`memory_pending`(accept) |
| 同目录 `backup/MEMORY-<scope>-<时间戳>.md` | **每次写入前**的整份备份 | `memory_add`、`memory_pending`(accept) |
| 同目录 `MEMORY.pending.md` | 待审队列（低置信条目） | `memory_add`(`pending: true`) |
| 同目录 `backup/undo.log` | 撤销记录（一行一次） | `memory_undo` |
| 同目录 `.autoscan.json` | autoScan 游标（已扫描的文件大小 + 已见过的发言 + 未合并队列） | `memory_scan`、开启 autoScan 时的 pre-step |

没有第六类文件。会话日志是**只读**的：不进这张表，因为从不写入。

### `memory_status` 做什么

报告"记忆看守"状态：当前 `DSH_HOME` 指向哪、有多少会话、是否存在其它 home 目录、两个记忆文件是否就位。

**起因是真实故障**：Harness 换过安装目录（改名后 `DSH_HOME` 指向新目录），
旧会话因不在新 home 里而从列表消失，看起来像"历史全丢了"。
有了这个工具，agent 可以直接查出来，不需要用户自己发现。

**自动化核实**：仓库里带 `smoke.mjs`，它把上述主张写成了**静态断言**，跑一次就知道有没有人偷偷改过：

```bash
node smoke.mjs                 # 共 45 项断言：12 项审计（静态）+ 33 项行为
node tools/publish-test.mjs    # 发布脚本的离线断言（纯函数，不联网）
```

它同时做行为测试。**任何一条审计断言失败，就不该再信任这个插件。**

---

## 安装

Harness 桌面端（profile 由应用托管，不要用 `dsh` CLI）：

```
设置（Ctrl+,）→ 插件市场 → 自定义安装 → 填 github:wojiao42/dsh-memory-file
```

或从本地路径装（开发时）：

```
插件市场 → 自定义安装 → 填本机绝对路径
```

> 注意：桌面端的 profile 受应用独占管理，`dsh plugin --profile desktop add ...` 会被拒绝。
> 走 GUI 的市场面板是官方通道（`inspect` → `installBundle`）。

## 配置

```yaml
- id: memory-file
  name: 'dsh-memory-file'
  config:
    maxBytes: 16384        # 单次注入的字节上限，超出会被截断
    dshHome: null          # 覆盖 $DSH_HOME（一般不用）
    header: '以下是用户长期记忆文件的内容。'   # 注入时用的引导语
    autoScan: false        # ★ 打开后才会读会话日志（默认关闭，见下文）
    autoScanMaxTurns: 30   # 单次最多列出多少条待合并发言
    autoScanMaxChars: 4000 # 待合并块的字符上限
```

## 用法

**自动部分**：每个会话的**第一次** `pre-step`，插件读取记忆文件并注入。
同一会话只注入一次，不会重复烧 token。

**工具部分**（agent 可调用，你也可以让它调）：

| 工具 | 作用 |
|---|---|
| `memory_add` | 写一条事实进记忆文件。可带 `source`（来源）与 `date`；`pending: true` 则只进待审队列不写记忆。**写前整份备份。** |
| `memory_recall` | 在记忆文件里做**纯文本**关键词搜索（多词为「与」） |
| `memory_list` | 列出记忆文件位置、大小、修改时间、备份份数、待审条数——**用来核对插件到底读了什么** |
| `memory_undo` | 撤回最近一次写入：恢复成写入前的整份内容（`list: true` 只列备份）。会一并丢弃那之后的改动，包括手写的 |
| `memory_pending` | 处理待审队列：`list` / `accept`（收进记忆，写前备份）/ `drop`（只改标记，不删文件） |
| `memory_scan` | 查看/处理「新对话待合并」：`status` / `preview`（列出原话）/ `scan`（立即扫一次会话日志）/ `ack`（推进游标，表示已处理完） |
| `memory_status` | 报告 `DSH_HOME`、会话数、同级其它 home、两个记忆文件是否就位——用来发现「历史对话凭空消失」 |

**记忆文件格式**：就是普通 Markdown，没有私有语法。你可以随时手改。

```markdown
# 记忆

- [2026-10-02] 喜欢简洁的回答，不要导语（来源：用户原话）
- 每周三晚上有固定安排
```

## autoScan：把"新对话"交给 agent 归档（v1.2.0，**默认关闭**）

打开 `autoScan: true` 后，每个会话的**第一次** pre-step 会顺带做一件事：

1. 增量扫描 `$DSH_HOME/sessions/`，只解码**大小变过**的会话日志
2. 只提取**你自己说的话** —— 带 `source.clientTimeZone` 的 `user/message`（运行时注入、技能目录、编排提示词都没有这个字段，因此不会被当成你说的话）
3. 把"还没合并"的发言（默认最近 30 条、≤4000 字符）附在记忆注入之后，并提示 agent：
   - 有把握的事实 → `memory_add`（带 `source`）
   - 拿不准的 → `memory_add(pending: true)`
   - 都没有 → 直接结束
4. agent 处理完调 `memory_scan(action: 'ack')` 推进游标；**不 ack 下次会话继续提示，不会丢**

### 它读了什么、没读什么

| | |
|---|---|
| 读 | `$DSH_HOME/sessions/**/session.v*.jsonl(.zstd)`，只读，只用来提取你自己的发言 |
| 不读 | `messages` 参数（从不解构）；助手回复的内容不会被当成"你说的话" |
| 不写 | 会话日志一个字都不改；游标写在记忆文件同目录的 `.autoscan.json` |
| 上限 | 单文件 >8MB 跳过；单轮读取总量 >32MB 收工（没处理完的下轮继续）；坏帧 / 坏 JSON 跳过 |
| 失败时 | 整段扫描包在 `try/catch` 里 —— 扫描出任何问题都只当"没有新发言"，不影响注入，更不影响对话 |

### 两个必须知道的技术细节

- `session.v*.jsonl.zstd` 是**追加写的多帧 zstd**：`zlib.zstdDecompressSync` 只解第一帧，插件按魔数 `28 b5 2f fd` 逐帧切开再解（`smoke.mjs` 用两帧夹具验证了这一点）
- 日志里的 `user/message` 大多数**不是人说的**：判别依据是 `source.clientTimeZone`，没有它的全部跳过

### 实测开销（一个几十个会话日志的环境）

| | |
|---|---|
| 首次全量扫描 | 亚秒级 |
| 之后每次会话 | 只 stat 文件大小，没变的文件不解码（毫秒级） |
| 注入块（30 条） | ~1.7 KB 字符 |

不想让它扫：保持 `autoScan: false`（默认）即可。此时 `memory_scan` 仍可手动 `scan` —— 那是你显式要求的动作，不是默认行为。

## 让用户"不用操心"但不失控

自动写记忆的难点不在"能不能自动"，而在**写错了怎么办**。写错一条不像答错一次 —— 它会在每个会话里反复生效。

所以这个插件的分工是：**机制自动，内容可见可撤回**。

| 场景 | 怎么办 |
|---|---|
| 有把握的事实 | 直接 `memory_add` 写进去（自动留备份） |
| 拿不准的 | `memory_add(pending: true)` 进待审队列，等你或 agent 之后 `accept` / `drop` |
| 写错了 | `memory_undo` 一键回到写入前（备份是整份文件，不只是那一行） |
| 想知道记了什么 | 记忆文件本身就是明文 Markdown；`memory_list` 报位置与大小 |

判断"值不值得记"这件事**仍然不在插件里**（它不读对话，也就无从判断）。它由每次对话里的 agent 做，或由你自己的脚本做 —— 插件负责把"写错了能撤回"这条路铺好。

## 怎么实现"自动更新记忆"（三条路）

**判断"值不值得记"不在插件里** —— 它不做模型调用、不总结、不推断。插件提供的是**素材**（你最近说过的话，来自 autoScan）和**护栏**（备份 / 撤销 / 待审），判断由对话里的 agent 做。按侵入性从小到大：

### 路径 1：让对话里的 agent 顺手记（零配置）

在任何会话里，agent 都能看到本插件的工具。在你的约定文件（如工作区 `AGENTS.md`）里加一条：

> 会话中发现关于用户的**持久事实**时：有把握的直接 `memory_add`（带 `source`）；拿不准的用 `memory_add(pending: true)` 进待审。不要问用户"要不要记住"。

- 判断发生在**有完整上下文的对话里**，质量最高 —— 它知道刚才聊了什么
- 不需要任何额外进程、调度或外部程序
- 漏记风险：agent 自己忘了。兜底办法是收尾前回顾一次本次会话

### 路径 2：打开插件自带的 autoScan（推荐与路径 1 搭配）

`autoScan: true` —— 插件负责"把新说的话摆到你面前"，agent 负责判断。细节见上面「autoScan」一节。

- 触发时机：每个会话的第一次 pre-step，你一发消息素材就到位
- 不会丢：agent 没 ack，游标不推进，下次会话继续提示
- 之所以默认关闭：让"读会话日志"成为你的**显式选择**，而不是装完就悄悄发生

### 路径 3：自己的脚本 + 模型判断（无人值守，最重）

定时扫会话日志 → 用一个 headless 会话把候选提取成 JSON → 逐条交给 `memory_add` / `memory_add(pending: true)`。

- 插件这边已经备好护栏：写前整份备份、`memory_undo` 回滚、低置信进待审
- 你还要自己加：单次写入条数上限、冲突不静默覆盖
- 代价：无人值守的判断**看不到完整对话**，误写概率高于前两条，而且要花钱

### 三条路对比

| 路径 | 触发时机 | 判断者 | 判断质量 | 外部依赖 | 漏记风险 |
|---|---|---|---|---|---|
| 1 agent 顺手记 | 对话进行中 | 当前对话的 agent | 最高（上下文完整） | 无 | 中（靠 agent 自觉） |
| 2 autoScan 供素材 | 每个会话首次 pre-step | 当前对话的 agent | 高（同一次对话上下文） | 无（插件内置） | 低（未 ack 会再提示） |
| 3 脚本 + 模型 | 定时任务 | 后台 headless 会话 | 中（只见发言碎片） | 调度器 / 常驻进程 | 低 |

**建议**：**1 + 2 一起用** —— 这就是"在自己的机器上全自动、且判断仍有完整上下文"的组合。只有当你要求"完全不参与"时才用路径 3，并务必保留备份与单次上限：无人值守写错一条，错的那条会在之后每个会话里反复生效。

## 设计取舍（先说清，免得期待错位）

**它不做判断，也不调模型。** 它不会总结、不会推断"什么值得记"。它只做两件事：**把素材找来**（可选，autoScan）和**把你写进去的东西管好**（备份 / 撤销 / 待审）。

这是**故意的**：一旦让插件自己判断，它就得调模型、就得花钱、就得"请信任我"，而它的全部价值恰恰是"你能自己读完并核实"。所以分工是：

```
取素材（可选：插件 autoScan —— 只读本地会话日志里你自己的发言）
   ↓
判断（对话里的 agent，或你自己的脚本 —— 明文可审）
   ↓ 写（memory_add / memory_add pending）
Markdown 记忆文件（+ 备份 + 待审队列，都可以用工具撤回）
   ↓ 读（会话首次 pre-step 注入）
本插件（不联网、不执行命令、不删文件）
```

**代价**：判断质量取决于你用哪个 agent —— 插件不替你想。
**收益**：整个过程你能逐行读懂、逐条核实；写错的成本被备份与撤销压到最低；读不读会话日志，由你一个开关决定。

## 兼容

- 安装源：npm / github / 本地路径
- 平台：DSH 桌面端（host 侧插件；没有客户端界面，就不需要 `dsh.client` 声明）
- 依赖：仅 `@deepseek-ai/dsh-llm`（构造注入消息）与 `@deepseek-ai/dsh-tools`（注册工具），均为 Harness 官方包

## 已知边界

1. **注入发生在会话首次 pre-step**。中途手改记忆文件，本会话不会生效（下个会话才读）。
2. **注入内容按 `maxBytes` 截断**，且会转义 `</system-reminder>` 防止记忆内容闭合框架。
3. **`memory_recall` 是字面匹配**，不是语义检索。没搜到不代表没记过。
4. **`memory_add` 不去重**。重复写入会得到重复行。
5. **`memory_undo` 是整份回退**，不是"撤销那一行"：写入之后你手改的内容会一起丢。只保留最近一次写入前的状态，不能连续回退多步。
6. **备份不清理**：每写一次多一份备份，不自动删除（因为插件不删文件）。介意的话自己删 `backup/` 下的旧文件。
7. **待审队列每 scope 一个**：工作区与全局各有自己的 `MEMORY.pending.md`，`accept` 只能收进同 scope 的记忆文件。
8. **autoScan 首次扫描会把历史也算进来**：第一次打开时可能一次冒出几百条（队列上限 300），`memory_scan(ack)` 一次清空即可。
9. **autoScan 游标跟着工作区走**：`.autoscan.json` 在记忆文件同目录，换工作区会看到那个工作区尚未 ack 的素材。
10. **助手回复不算"你说的话"**：autoScan 只认 `user/message`。所以只在回复里出现过的结论（"那就定 X 吧"）不会自动被找到。

## 版本

- **v1.2.0**（当前）：新增 `autoScan`（可选、默认关闭）—— 读本机会话日志、只提取你自己的发言、附在注入里提示 agent 归档；新增 `memory_scan` 工具；会话日志读取纳入审计登记，并有单文件 / 单轮资源上限。
- **v1.1.0**：写入前整份备份、`memory_undo`、`memory_pending`（待审队列）、`memory_add` 的来源标注；审计升级为「敏感操作逐个登记」。
- v1.0.0：注入 + 四个工具（add / recall / list / status），修复工具结果渲染。

## 收录状态

- 仓库：<https://github.com/wojiao42/dsh-memory-file>（已带 `dsh-plugin` topic）
- 目标目录：社区精选 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
  `dsh-plugin.org` 上的条目从它同步 —— **进了这个目录就等于进了插件市场**
- 分类：`memory`
- 不放 npm：市场客户端是 **npm 优先、GitHub 兜底**，`github:` 安装即可用
- 发布流程与命令见 [PUBLISHING.md](./PUBLISHING.md)，脚本是 `tools/publish.mjs`

## 许可

MIT
