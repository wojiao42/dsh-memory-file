# dsh-memory-file

给 DeepSeek Harness 的**文件型长期记忆**：每个会话开始注入你自己的 Markdown 记忆文件，并提供三个工具让 agent 读写它。

**这个插件的核心卖点不是功能，是可核实性。** 它刻意做得很小，小到你能在几分钟内读完并自己确认它做了什么。

---

## 它不做什么（这是设计约束，可对照源码逐条核实）

| 主张 | 怎么自己核实 |
|---|---|
| **不读你的对话** | 全文唯一的订阅是 `ctx.on('agent/pre-step')`，且回调参数里**没有解构 `messages`**。搜索 `ctx.on(` 只有一处。 |
| **不联网** | 全文没有 `fetch` / `http` / `https` / `net` / `dns` / `tls` / WebSocket。检查 `import` 语句：只有 `node:fs`、`node:os`、`node:path`，加两个 DSH 官方包。 |
| **不执行命令** | 没有 `child_process`。 |
| **不删你的文件** | 没有 `rmSync` / `unlinkSync` / `renameSync` / `copyFileSync`。 |
| **只碰两个路径** | `$DSH_HOME/memory/MEMORY.md`（全局）与 `<cwd>/.dsh/memory/MEMORY.md`（工作区）。见 `resolveMemoryPaths()`。 |

### 有意识的例外（说清楚，不藏）

`memory_status` 工具会**列目录名**（`readdirSync`），用来判断"历史对话是不是因为 Harness 换目录而看不到"：

- 它枚举 `$DSH_HOME/sessions` 与 `$DSH_HOME` 的**同级目录**，只看**目录名与文件个数**
- **不读任何会话文件内容**（断言里专门检查了 `readdirSync` 后面不会紧跟 `readFileSync`）

如果你不要这个能力，删掉 `memory_status` 即可——其余部分不依赖它。

### `memory_status` 做什么

报告"记忆看守"状态：当前 `DSH_HOME` 指向哪、有多少会话、是否存在其它 home 目录、两个记忆文件是否就位。

**起因是真实故障**：Harness 换目录后（`<DSH 安装目录>` → `<DSH 安装目录>`），
旧会话因不在新 home 里而从列表消失，看起来像"历史全丢了"。
有了这个工具，agent 可以直接查出来，不需要用户自己发现。

**自动化核实**：仓库里带 `smoke.mjs`，它把这五条写成了**静态断言**，跑一次就知道有没有人偷偷改过：

```bash
node smoke.mjs
```

它同时做行为测试（16 项）。**任何一条审计断言失败，就不该再信任这个插件。**

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
| `memory_add` | 追加一条事实到记忆文件（可指定 `scope: global` 写全局） |
| `memory_recall` | 在记忆文件里做**纯文本**关键词搜索（多词为「与」） |
| `memory_list` | 列出记忆文件位置、大小、修改时间——**用来核对插件到底读了什么** |

**记忆文件格式**：就是普通 Markdown，没有私有语法。你可以随时手改。

```markdown
# 记忆

- [2026-10-02] 喜欢简洁的回答，不要导语
- 每周三晚上有固定安排
```

## 设计取舍（先说清，免得期待错位）

**它不做自动提炼。** 它不会读你的对话、不会自己总结出新事实。

这是**故意的**：一旦要"自动提炼"，插件就必须读你的全部对话，
安全主张就从「可核实」变成「请信任我」。所以：

```
提炼（可选，跑在你自己的脚本里，明文可审）
   ↓ 写
Markdown 记忆文件
   ↓ 读
本插件（只注入 + 提供手动读写工具）
```

**代价**：需要你（或你本地的脚本）把值得记的东西写进那个 `.md`。
**收益**：这个插件**看不到你的对话**，而这一点你可以自己验证。

## 兼容

- 安装源：npm / github / 本地路径
- 平台：DSH 桌面端（host 侧插件；没有客户端界面，就不需要 `dsh.client` 声明）
- 依赖：仅 `@deepseek-ai/dsh-llm`（构造注入消息）与 `@deepseek-ai/dsh-tools`（注册工具），均为 Harness 官方包

## 已知边界

1. **注入发生在会话首次 pre-step**。中途手改记忆文件，本会话不会生效（下个会话才读）。
2. **注入内容按 `maxBytes` 截断**，且会转义 `</system-reminder>` 防止记忆内容闭合框架。
3. **`memory_recall` 是字面匹配**，不是语义检索。没搜到不代表没记过。
4. **没有自动去重**。重复调用 `memory_add` 会写入重复行。

## 许可

MIT
