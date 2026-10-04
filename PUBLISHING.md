# 发布清单 / Publishing

目标：让 `dsh-memory-file` 进入社区精选目录
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
`dsh-plugin.org` 上的条目从这个目录同步，所以**进了这里就等于进了插件市场**，
不需要另外向 `api.dsh-plugin.org` 投稿（那个域名只提供目录 JSON，没有投稿接口）。

## 一、前置条件核对

| 收录要求（来自 contributing.md） | 本仓库状态 |
|---|---|
| `package.json` 声明 `dsh.bundle`（**只声明 `dsh.client` 会被 CI 直接拒**） | ✅ `dsh.bundle.patch` → `./cordis.patch.yml` |
| `cordis.patch.yml` 紧邻 `package.json`，插入行的 `name` 与包名一致 | ✅ `name: dsh-memory-file` |
| 包根就是仓库根（CI 只读根包 / `packages/`·`plugins/`·`apps/` 子包） | ✅ 本目录整体作为仓库根 |
| 构建产物已提交（git 安装不跑构建） | ✅ 纯 host 侧插件，无构建步骤，`index.js` 即产物 |
| 仓库创建满 **1 天** | ✅ 建于 `2026-10-02T11:44:29Z`，`2026-10-03T11:44:29Z`（北京 19:44）后满足 |
| 仓库带 `dsh-plugin` topic | ✅ 已有 `dsh-plugin` / `deepseek-harness` / `dsh` / `memory` |
| 描述含英文 `: ` 时必须加引号 | ✅ `submissionYaml()` 自动加引号，`tools/publish-test.mjs` 有断言 |

分类选 **`memory`**：contributing.md 的 category 列表里 `memory` 是独立分类，
本插件做的事就是「把你的 Markdown 记忆文件读进来、写回去」，不存在更贴切的归类。

## 二、发布命令

`tools/publish.mjs` 把 GitHub 侧全部步骤固化了。令牌只经 **环境变量**交给 `gh`，
并经 `GIT_CONFIG_*` 注入推送用的 http 头 —— 不进命令行参数、不进 git remote URL、不落盘：

```sh
node tools/publish.mjs --dry-run      # 先看它要做什么，零副作用
node tools/publish.mjs                # 推送 main + 补 topic（已建仓，幂等）
node tools/publish.mjs --prepare-pr   # 推 fork 与收录分支（不受 1 天限制）
node tools/publish.mjs --pr           # 仓库满 1 天后提收录 PR
```

令牌来源（按顺序）：

1. `GH_TOKEN` / `GITHUB_TOKEN` 环境变量
2. `--token-file <路径>`
3. `<插件目录>/.gh-token` → 当前目录 `.gh-token` → 上级目录 `.gh-token`

**必须是经典 PAT，勾 `public_repo` + `read:user`**（细粒度令牌无法建仓库）。
脚本会自动：读登录名 → 写 `LICENSE`（MIT，版权行 = 登录名）→ 补 `package.json` 的
`repository` → 提交 → `gh repo create --public --push`（已存在则复用）→ 补 topic
→ 把收录条目生成到 `dist/awesome-submission/`。

`--pr` 会先查仓库 `created_at`，**不满 1 天直接拒绝并告诉你还差多久**，
不会去提一个必红的 PR。

> ⚠️ **年龄门槛按 PR 的创建时刻算，不是按 CI 运行时刻。**
> 上游 `pr-gate.yml` 把 `--pr-created "${{ steps.pr.outputs.created_at }}"` 传进校验脚本，
> 所以"先提出来、等仓库长大了再重跑 CI"这条路走不通 —— 重跑时 PR 创建时刻没变，
> 它会一直红。**必须等满 1 天之后再创建 PR。**
>
> 另：PR 的分支允许落后 `main`。gate 用 `git merge-base origin/main pr-head` 算本 PR 自己的
> 贡献，所以不必为了"跟上上游"去重建分支（实测落后 68 个提交依然能正确判定）。

### 本机实际情况（2026-10-03）

| 项 | 值 |
|---|---|
| `gh` | 便携版 `%LOCALAPPDATA%\Programs\gh\bin\gh.exe`（2.101.0），`findGh()` 能找到 |
| 令牌文件 | `<工作区根>\.gh-token`（**不在插件目录**，所以用环境变量或 `--token-file` 传入） |
| 仓库 | `wojiao42/dsh-memory-file` 已存在、公开、topic 已设 —— 走的是"推送 + 提 PR"，不是"建仓" |
| fork | `wojiao42/awesome-dsh-plugin` 已存在（含 `add-dsh-token-cost`、`add-dsh-space-optimizer` 分支） |

> `gh auth login --web`（设备码）在本机**走不通**：出口代理没有路由
> `github.com/login/oauth/access_token`。`api.github.com` 与 git 智能 HTTP 正常，
> 所以环境变量 + PAT 这条路径可用。

## 三、收录条目

`data/plugins/` 下一个插件一个文件，新增 **`data/plugins/wojiao42__dsh-memory-file.yml`**：

```yaml
url: https://github.com/wojiao42/dsh-memory-file
name: wojiao42/dsh-memory-file
category: memory
description:
  en: 'File-backed memory: injects your own Markdown memory file at each session start, adds read/write tools, and reports DSH_HOME drift. It never reads conversations and never opens a network connection.'
  zh: 文件型长期记忆：每个会话开始注入你自己的 Markdown 记忆文件，提供读写工具，并能查出 DSH_HOME 漂移。不读对话、不联网，且这两条可用源码逐条核实。
```

文案的**唯一来源**是 `tools/publish.mjs` 里的 `DESCRIPTION` 常量，
脚本生成到 `dist/awesome-submission/`，不要手写第二份。

**不要手工编辑仓库根的两个 README**——它们由 `data/plugins/*.yml` 生成。
一个 PR 最多 3 条。

## 四、不放 npm

市场客户端是 **npm 优先、GitHub 兜底**，所以不发 npm 也能被正常安装
（目录里的 `ic` 字段就是 `dsh plugin --profile desktop add github:wojiao42/dsh-memory-file`）。
本插件零构建、零运行时依赖（只有两个 DSH 官方包），GitHub 安装没有任何额外代价。

若日后要发 npm：`dsh-memory-file` 这个名字目前**未被占用**（registry 404），
但不要手写投稿 YAML 的 `npm:` 键 —— npm 映射由 registry 自动采集，手写会被校验拒绝。

## 五、回滚

- 收录未合并：关掉 PR 即可，本仓库不受影响。
- 已合并要下架：向该目录提一个删除 yml 的 PR。
- 用户侧卸载：插件市场面板里卸载，或从 profile 的 `dependencies` 里移除 `dsh-memory-file`。
