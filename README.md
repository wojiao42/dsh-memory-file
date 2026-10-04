# dsh-memory-file

给 DeepSeek Harness 的**文件型长期记忆**：每个会话开始注入你自己的 Markdown 记忆文件，并提供工具让 agent 读写它、把拿不准的放进待审队列、撤回写错的一条，以及核对它到底读过什么。

**这个插件的核心卖点不是功能，是可核实性。** 它刻意做得很小，小到你能在几分钟内读完并自己确认它做了什么。
v1.1.0 起还多了一层机制：**任何敏感操作（列目录、复制文件）都必须在调用处逐个登记用途，`smoke.mjs` 会核对登记数量与实际调用数量** —— 偷偷加一处，自测立刻变红。

---

## 它不做什么（这是设计约束，可对照源码逐条核实）

| 主张 | 怎么自己核实 |
|---|---|
| **不读你的对话** | 全文唯一的订阅是 `ctx.on('agent/pre-step')`，且回调参数里**没有解构 `messages`**。搜索 `ctx.on(` 只有一处。 |
| **不联网** | 全文没有 `fetch` / `http` / `https` / `net` / `dns` / `tls` / WebSocket。检查 `import` 语句：只有 `node:fs`、`node:os`、`node:path`，加两个 DSH 官方包。 |
| **不执行命令** | 没有 `child_process`，也没有 `spawn` / `execSync`。 |
| **不删、不改名、不改权限** | 没有 `rmSync` / `unlinkSync` / `renameSync` / `chmodSync` / `rmdirSync`。（待审条目「丢弃」只是改标记 `- [-]`，不删文件。） |
| **只碰记忆文件附近的那几个位置** | 全部路径由 `resolveMemoryPaths()` + `sidecarPaths(memoryFile)` 推导，不接受任何外部传入的路径。见下节。 |
| **敏感操作逐个登记** | `readdirSync` / `copyFileSync` 每次调用，上一行必须有 `[audit:readdir]` / `[audit:copy]` 说明；`smoke.mjs` 断言登记数 == 调用数。 |

### 它到底会写哪些文件

| 位置 | 内容 | 谁写 |
|---|---|---|
| `$DSH_HOME/memory/MEMORY.md` | 全局记忆 | `memory_add`（`scope: global`） |
| `<工作区>/.dsh/memory/MEMORY.md` | 工作区记忆（默认目标） | `memory_add`、`memory_pending`(accept) |
| 同目录 `backup/MEMORY-<scope>-<时间戳>.md` | **每次写入前**的整份备份 | `memory_add`、`memory_pending`(accept) |
| 同目录 `MEMORY.pending.md` | 待审队列（低置信条目） | `memory_add`(`pending: true`) |
| 同目录 `backup/undo.log` | 撤销记录（一行一次） | `memory_undo` |

没有第五类文件。

### `memory_status` 做什么

报告"记忆看守"状态：当前 `DSH_HOME` 指向哪、有多少会话、是否存在其它 home 目录、两个记忆文件是否就位。

**起因是真实故障**：Harness 换过安装目录（改名后 `DSH_HOME` 指向新目录），
旧会话因不在新 home 里而从列表消失，看起来像"历史全丢了"。
有了这个工具，agent 可以直接查出来，不需要用户自己发现。

**自动化核实**：仓库里带 `smoke.mjs`，它把上述主张写成了**静态断言**，跑一次就知道有没有人偷偷改过：

```bash
node smoke.mjs                 # 共 34 项断言：9 项审计（静态）+ 25 项行为
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
| `memory_status` | 报告 `DSH_HOME`、会话数、同级其它 home、两个记忆文件是否就位——用来发现「历史对话凭空消失」 |

**记忆文件格式**：就是普通 Markdown，没有私有语法。你可以随时手改。

```markdown
# 记忆

- [2026-10-02] 喜欢简洁的回答，不要导语（来源：用户原话）
- 每周三晚上有固定安排
```

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

## 设计取舍（先说清，免得期待错位）

**它不做自动提炼。** 它不会读你的对话、不会自己总结出新事实。

这是**故意的**：一旦要"自动提炼"，插件就必须读你的全部对话，
安全主张就从「可核实」变成「请信任我」。所以：

```
提炼（可选：跑在你自己的脚本里，或由对话里的 agent 做，明文可审）
   ↓ 写（memory_add / memory_add pending）
Markdown 记忆文件（+ 备份 + 待审队列，都可以用工具撤回）
   ↓ 读（会话首次 pre-step 注入）
本插件（不读对话、不联网、不执行命令）
```

**代价**：需要你（或你本地的脚本、你的 agent）把值得记的东西写进那个 `.md`。
**收益**：这个插件**看不到你的对话**，而这一点你可以自己验证；同时写错的成本被备份和撤销压到最低。

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

## 版本

- **v1.1.0**（当前）：新增写入前整份备份、`memory_undo`、`memory_pending`（待审队列）、`memory_add` 的来源标注；审计升级为「敏感操作逐个登记」。
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
