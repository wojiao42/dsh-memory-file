/**
 * dsh-memory-file — 文件型长期记忆插件
 *
 * 设计约束（安全主张可被外部核实，请对照源码逐条检查）：
 *
 *   1. 不读 `messages`。pre-step 的回调参数从不解构 `messages`，源码里也不订阅任何
 *      携带消息内容的事件（如 `agent/message`、`user/message`）。
 *      **唯一能触达对话内容的开关是 `autoScan`，默认 false。** 打开后插件会读
 *      `$DSH_HOME/sessions/` 下的会话日志，只提取"你自己说的话"（带
 *      `source.clientTimeZone` 的 `user/message`），用来提醒 agent"有新的持久事实可记"。
 *      关闭时（默认）代码路径根本不触达会话目录 —— 这条由 smoke.mjs 的
 *      「默认不读会话日志」断言守着。会话日志的读取在调用处用 `[audit:sessions]` 登记。
 *   2. 不联网。源码中不存在 `fetch` / `http` / `https` / `net` / `dns` / `tls` / WebSocket。
 *   3. 不执行命令。源码中不存在 `child_process`。
 *   4. 不删、不改名、不改权限。没有 `rmSync` / `unlinkSync` / `renameSync` / `chmodSync`。
 *   5. 写入位置全部由 `resolveMemoryPaths` + `sidecarPaths` 推导，共四类：
 *        - 记忆文件本身：`$DSH_HOME/memory/MEMORY.md`（全局）与 `<cwd>/.dsh/memory/MEMORY.md`（工作区）
 *        - 备份：记忆文件同目录下的 `backup/MEMORY-<scope>-<时间戳>.md`
 *        - 待审队列：记忆文件同目录下的 `MEMORY.pending.md`
 *        - autoScan 游标：记忆文件同目录下的 `.autoscan.json`
 *   6. 会话日志**只读**：不复制、不上传、不修改；扫描结果只用于生成注入文本。
 *
 *   敏感操作登记制（v1.1.0 起）：`readdirSync`（列目录）与 `copyFileSync`（复制）必须在调用处
 *   用紧邻上一行的 `[audit:readdir]` / `[audit:copy]` 注释说明用途；`smoke.mjs` 会核对
 *   「登记数量 == 实际调用数量」。想偷偷加一处枚举或复制，测试就会变红。
 *
 * 如果后续有人修改本文件，请同时修改 README 的「可核实约束」一节，并重新核对上述六条。
 * 违反上述任一条都应当被视为破坏性变更。
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'memory-file';

/**
 * 声明对 tools 服务的依赖。
 * 缺少它时 cordis 不会等待服务就绪，`ctx.tools` 可能为 undefined，
 * 工具会静默不注册——这个坑已经踩过一次，所以显式声明。
 */
export const inject = ['tools'];

/** 单个记忆文件的最大注入字节数，防止一条巨型记忆撑爆上下文。 */
const DEFAULT_MAX_BYTES = 16384;

/** 注入内容不得包含伪造的框架闭合标签。 */
const FRAMEWORK_CLOSE = '</system-reminder>';

/** 备份目录里最多报告多少条（undo --list 用，避免刷屏）。 */
const MAX_BACKUP_LIST = 10;

/**
 * autoScan 默认值：**关闭**。
 * 打开后插件才会读 `$DSH_HOME/sessions` 下的会话日志、提取你自己的发言并提示 agent 合并。
 * 默认关闭是刻意的：不让"读对话"变成默认行为。
 */
const DEFAULT_AUTO_SCAN = false;
/** autoScan 单次最多展示多少条待合并发言。 */
const DEFAULT_AUTO_SCAN_MAX_TURNS = 30;
/** 待合并队列最多保留多少条（防止里面积压几千条）。 */
const MAX_PENDING_TURNS = 300;
/** autoScan 注入块的字符上限。 */
const DEFAULT_AUTO_SCAN_MAX_CHARS = 4000;
/** seen 去重表超过这个规模就裁剪，只留最近的。 */
const MAX_SEEN_KEYS = 5000;
/** 多帧 zstd 的帧魔数（DSH 的 session 日志是追加写的多帧）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** 单个会话日志的读取上限：超过就跳过，避免一个巨型日志卡住会话首个请求。 */
const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
/** 单次扫描的读取总量上限：超了就收工，没来得及处理的文件下一轮继续（size 未推进）。 */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

function escapeFramework(text) {
  return text.split(FRAMEWORK_CLOSE).join('<\\/system-reminder>');
}

/**
 * 记忆文件的候选路径，按优先级排列（先全局后工作区）。
 * 写入目标：有工作区就用工作区的，否则用全局的。
 */
function resolveMemoryPaths(cwd, dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  const global = join(home, 'memory', 'MEMORY.md');
  const workspace = cwd ? join(resolve(cwd), '.dsh', 'memory', 'MEMORY.md') : undefined;
  return {
    global,
    workspace,
    /** 写入目标：有工作区就用工作区的，否则用全局的。 */
    target: workspace || global,
  };
}

/**
 * 旁路文件（备份、待审队列）的位置，**全部由记忆文件路径推导**。
 * 这是「只碰这几个位置」这条主张的实现方式：不接收任何外部路径。
 */
function sidecarPaths(memoryFile) {
  const dir = dirname(memoryFile);
  return {
    backupDir: join(dir, 'backup'),
    pendingFile: join(dir, 'MEMORY.pending.md'),
    scanStateFile: join(dir, '.autoscan.json'),
  };
}

/** 记忆文件的 scope 标签，用于备份文件名。 */
function scopeOf(file, paths) {
  return file === paths.global ? 'global' : 'workspace';
}

/** 用给定 scope 解析出记忆文件与旁路文件。 */
function targetFor(paths, scope) {
  const file = scope === 'global' ? paths.global : paths.target;
  return { file, scope: scope === 'global' ? 'global' : 'workspace', ...sidecarPaths(file) };
}

function readIfExists(file) {
  try {
    if (!existsSync(file)) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 本地日期 YYYY-MM-DD。 */
function todayLocal(date = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 备份文件名用的本地时间戳 YYYYMMDD-HHMMSSmmm。 */
function backupStamp(date = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return [
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`,
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`,
  ].join('-');
}

/**
 * 写入前整份备份记忆文件。文件不存在时返回空字符串（首次创建没有可备份的内容）。
 * 源与目标都由记忆文件路径推导，不接受外部路径。
 */
function backupBeforeWrite(file, scope) {
  if (!existsSync(file)) return '';
  const { backupDir } = sidecarPaths(file);
  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `MEMORY-${scope}-${backupStamp()}.md`);
  // [audit:copy] 仅用于写入前备份：源=记忆文件，目标=同目录 backup/ 下的推导路径
  copyFileSync(file, dest);
  return dest;
}

/** 最近的备份文件（按文件名排序，时间戳单调递增）。 */
function latestBackup(file, scope) {
  const { backupDir } = sidecarPaths(file);
  if (!existsSync(backupDir)) return undefined;
  const prefix = `MEMORY-${scope}-`;
  // [audit:readdir] 枚举备份目录；只接受 MEMORY-<scope>-<时间戳>.md 形式的文件名
  const names = readdirSync(backupDir).filter((n) => n.startsWith(prefix) && n.endsWith('.md'));
  if (names.length === 0) return undefined;
  names.sort();
  return join(backupDir, names[names.length - 1]);
}

/** 备份文件清单（最近的在前）。 */
function listBackups(file, scope) {
  const { backupDir } = sidecarPaths(file);
  if (!existsSync(backupDir)) return [];
  const prefix = `MEMORY-${scope}-`;
  // [audit:readdir] 枚举备份目录；同样只接受推导出的文件名形式
  const names = readdirSync(backupDir).filter((n) => n.startsWith(prefix) && n.endsWith('.md'));
  return names
    .sort()
    .reverse()
    .slice(0, MAX_BACKUP_LIST)
    .map((n) => {
      const full = join(backupDir, n);
      let bytes = 0;
      let modifiedAt = '';
      try {
        const st = statSync(full);
        bytes = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // 读不到就留空，不影响主流程
      }
      return { name: n, file: full, bytes, modifiedAt };
    });
}

// ─────────────────────────────────────────────────────────────
// autoScan：读会话日志，提取「你自己的发言」→ 提示 agent 合并
//   只在 autoScan 打开时由 pre-step 调用；也可由 memory_scan(action:'scan') 显式触发。
//   只读，不复制、不上传；游标写在记忆文件同目录的 .autoscan.json。
// ─────────────────────────────────────────────────────────────

/** 解析 home（sessions 目录与全局记忆都挂在它下面）。 */
function resolveHome(dshHome) {
  return dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * 多帧 zstd 逐帧解压。
 * 坑：DSH 的 `session.v*.jsonl.zstd` 是**追加写的多帧** zstd，
 * `zstdDecompressSync` 只解第一帧，所以必须按魔数切帧、逐帧解、再拼起来。
 */
export function decodeSessionBuffer(buf) {
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  if (offsets.length === 0) {
    try {
      return zstdDecompressSync(buf).toString('utf8');
    } catch {
      return buf.toString('utf8'); // 明文日志
    }
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 跳过损坏帧，不中断整场扫描
    }
  }
  return parts.join('');
}

/** 列出会话日志文件（按修改时间升序）。 */
export function listSessionFiles(home) {
  const sessionsDir = join(home, 'sessions');
  const files = [];
  if (!existsSync(sessionsDir)) return files;
  try {
    // [audit:readdir] 枚举 $DSH_HOME/sessions 下的工作区桶目录名
    for (const bucket of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = join(sessionsDir, bucket.name);
      // [audit:readdir] 枚举桶下的会话目录名
      for (const sess of readdirSync(bucketDir, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue;
        const sessDir = join(bucketDir, sess.name);
        // [audit:readdir] 枚举会话目录下的日志文件名（只接受 session.v<n>.jsonl[.zstd]）
        for (const name of readdirSync(sessDir)) {
          if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(name)) continue;
          const full = join(sessDir, name);
          try {
            const st = statSync(full);
            files.push({ session: sess.name, bucket: bucket.name, file: full, size: st.size, mtime: st.mtimeMs });
          } catch {
            // stat 不到就跳过这个文件
          }
        }
      }
    }
  } catch {
    // home 不可读就当没有会话
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

/**
 * 从解压后的日志文本里抽出**真人发言**。
 * 关键判别：`user/message` 大部分不是人说的（运行时上下文、技能目录、编排脚本提示词都长这样）。
 * 真人发言带 `source.clientTimeZone`，注入的没有。
 */
export function extractUserTurns(text, session) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== 'user/message') continue;
    const data = ev.data || {};
    if (!data.source || data.source.kind !== 'user') continue;
    if (!data.source.clientTimeZone) continue;
    const body = (data.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!body) continue;
    out.push({ session, seq: ev.seq ?? out.length, time: ev.time ?? null, text: body });
  }
  return out;
}

/** 读游标文件；不存在或坏了就当空。 */
export function loadScanState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      version: 1,
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
    };
  } catch {
    return { version: 1, files: {}, seen: {}, turns: [] };
  }
}

export function saveScanState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 增量扫描：只解码"大小变过"的会话文件，按 `session#seq` 去重。
 * 返回本次新增的发言，并把它们追加进待合并队列（state.turns）。
 */
export function scanNewTurns(home, state) {
  const added = [];
  let scannedBytes = 0;
  for (const f of listSessionFiles(home)) {
    if (state.files[f.session] === f.size) continue; // 文件没变就不解码
    // 边界：单文件过大直接跳过；本轮读取总量超限就收工（没推进 size 的文件下轮继续）
    if (f.size > MAX_SESSION_FILE_BYTES) continue;
    if (scannedBytes + f.size > MAX_SCAN_BYTES) break;
    scannedBytes += f.size;
    let buf;
    try {
      // [audit:sessions] 读会话日志文件（autoScan 的唯一数据来源，只读不写）
      buf = readFileSync(f.file);
    } catch {
      continue;
    }
    for (const turn of extractUserTurns(decodeSessionBuffer(buf), f.session)) {
      const key = `${turn.session}#${turn.seq}`;
      if (state.seen[key]) continue;
      state.seen[key] = 1;
      added.push(turn);
    }
    state.files[f.session] = f.size;
  }
  added.sort((a, b) => (a.time || 0) - (b.time || 0));
  if (added.length) state.turns = [...state.turns, ...added].slice(-MAX_PENDING_TURNS);
  // 去重表无限增长会拖慢扫描，超限就只留最近的一半
  const keys = Object.keys(state.seen);
  if (keys.length > MAX_SEEN_KEYS) {
    const keep = keys.slice(-Math.floor(MAX_SEEN_KEYS / 2));
    state.seen = Object.fromEntries(keep.map((k) => [k, 1]));
  }
  return added;
}

/** 把待合并发言格式化成注入块。 */
export function formatPendingTurns(turns, total, maxChars = DEFAULT_AUTO_SCAN_MAX_CHARS) {
  const lines = turns.map((t, i) => {
    const when = t.time ? new Date(t.time).toISOString().slice(0, 10) : '日期不详';
    return `${i + 1}. [${when}] ${String(t.text).replace(/\s+/g, ' ')}`;
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n…（已截断）`;
  return [
    `<!-- autoScan：新对话待合并（共 ${total} 条，下面是最新的 ${turns.length} 条） -->`,
    '以下是**你自己**最近在对话里说过的话（取自本机会话日志）：',
    '',
    body,
    '',
    '请判断其中有没有**关于你的持久事实**（身份、偏好、禁忌、长期项目、对已有记忆的修正）：',
    '  · 有把握的 → `memory_add`（带上 source）',
    '  · 拿不准的 → `memory_add(pending: true)` 进待审',
    '  · 都没有 → 直接结束，不要为了凑数写',
    '处理完调用 `memory_scan`（action: ack）推进游标；不 ack 的话下次会话还会提示。',
  ].join('\n');
}

/** 从记忆文件里挑出与关键词匹配的行（纯文本匹配，不做语义检索）。 */
function searchLines(text, terms) {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const hits = [];
  for (const line of text.split('\n')) {
    const lower = line.toLowerCase();
    if (needles.every((n) => lower.includes(n))) hits.push(line);
  }
  return hits;
}

/** 人类可读的字节数。 */
function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 待审文件的表头（首次创建时写入）。 */
const PENDING_HEADER = [
  '# 待审记忆',
  '',
  '> 低置信或待确认的条目。确认后用 `memory_pending`（action=accept）收进 MEMORY.md，或（action=drop）丢弃。',
  '> 这个文件是普通 Markdown，你可以直接手改。',
  '',
].join('\n');

/** 把一条待审条目追加进待审文件。 */
function appendPending(pendingFile, entry) {
  mkdirSync(dirname(pendingFile), { recursive: true });
  if (!existsSync(pendingFile)) writeFileSync(pendingFile, PENDING_HEADER, 'utf8');
  appendFileSync(pendingFile, `- [ ] ${entry}\n`, 'utf8');
}

/**
 * 解析待审文件：未处理（`- [ ]`）的按出现顺序编号，从 1 开始。
 * 返回 { open: [{index, line, text}], resolved: number }。
 */
function parsePending(text) {
  const open = [];
  let resolved = 0;
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    if (/^- \[ \] /.test(line)) {
      open.push({ index: open.length + 1, line: i, text: line.replace(/^- \[ \] /, '') });
    } else if (/^- \[[x-]\] /.test(line)) {
      resolved++;
    }
  });
  return { open, resolved };
}

/** 把待审文件里第 lineIndex 行的状态标记改写掉（accept → [x]，drop → [- ]）。 */
function markPending(pendingFile, text, target, mark) {
  const lines = String(text).split('\n');
  if (!lines[target.line] || !/^- \[ \] /.test(lines[target.line])) {
    throw new Error(`待审条目 ${target.index} 已被处理过，请重新 list。`);
  }
  lines[target.line] = lines[target.line].replace(/^- \[ \] /, `- [${mark}] `);
  writeFileSync(pendingFile, lines.join('\n'), 'utf8');
}

/** 记录一次撤销，便于事后追溯（追加在备份目录，不动记忆文件）。 */
function logUndo(file, scope, backupName, restoredEntry) {
  const { backupDir } = sidecarPaths(file);
  mkdirSync(backupDir, { recursive: true });
  appendFileSync(
    join(backupDir, 'undo.log'),
    `${new Date().toISOString()} scope=${scope} backup=${backupName} restoredBytes=${restoredEntry}\n`,
    'utf8',
  );
}

export function apply(ctx, config = {}) {
  const maxBytes = Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES;
  const dshHome = config.dshHome;
  const header = config.header ?? '以下是用户长期记忆文件的内容。它是用户自己维护的明文笔记，请作为背景参考。';
  // autoScan：**默认关闭**。只有显式传 true 才会读会话日志（见文件头设计约束第 1 条）。
  const autoScan = config.autoScan === true;
  const autoScanMaxTurns = Number.isFinite(config.autoScanMaxTurns)
    ? Math.max(1, config.autoScanMaxTurns)
    : DEFAULT_AUTO_SCAN_MAX_TURNS;
  const autoScanMaxChars = Number.isFinite(config.autoScanMaxChars)
    ? Math.max(200, config.autoScanMaxChars)
    : DEFAULT_AUTO_SCAN_MAX_CHARS;
  const scanHome = resolveHome(dshHome);

  const pathsFor = (agent) => resolveMemoryPaths(agent?.session?.header?.cwd, dshHome);

  // ─────────────────────────────────────────────────────────────
  // 1) 注入：每个会话的首次 pre-step，把记忆文件内容作为一条 user 消息注入
  //    ★ 注意：这里刻意不读 messages 参数的内容，只用 step 判断是否首次。
  // ─────────────────────────────────────────────────────────────
  const injected = new WeakSet();

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    if (step !== 1) return decision;
    if (!agent || injected.has(agent)) return decision;
    if (decision.kind === 'reject') return decision;

    const { global, workspace } = pathsFor(agent);
    // 优先注入工作区记忆；不存在则退回全局记忆。两者都存在时都注入。
    const parts = [];
    for (const [scope, file] of [['全局', global], ['工作区', workspace]]) {
      if (!file) continue;
      const text = readIfExists(file);
      if (text === undefined || text.trim() === '') continue;
      parts.push(`<!-- scope: ${scope} (${file}) -->\n${text}`);
    }

    // autoScan（默认关闭）：顺手把"还没合并的新发言"一起注入。
    // 整段包在 try/catch 里 —— 扫描出的任何问题都不该影响注入，更不该影响对话本身。
    if (autoScan) {
      try {
        const anchor = workspace || global;
        const { scanStateFile } = sidecarPaths(anchor);
        const scanState = loadScanState(scanStateFile);
        scanNewTurns(scanHome, scanState);
        saveScanState(scanStateFile, scanState);
        const pending = scanState.turns.slice(-autoScanMaxTurns);
        if (pending.length) parts.push(formatPendingTurns(pending, scanState.turns.length, autoScanMaxChars));
      } catch {
        // 扫描失败就当没有新发言，什么都不做
      }
    }

    if (parts.length === 0) {
      injected.add(agent);
      return decision;
    }

    const body = escapeFramework(parts.join('\n\n---\n\n'));
    let content = `<system-reminder>\n${header}\n\n${body}\n</system-reminder>`;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = `<system-reminder>\n${header}\n\n（记忆内容超过 ${maxBytes} 字节上限，已截断；请让用户精简记忆文件。）\n\n${escapeFramework(body.slice(0, maxBytes))}\n</system-reminder>`;
    }

    injected.add(agent);
    signal?.throwIfAborted?.();

    let message;
    try {
      // content 必须是 content-block 数组。传裸字符串会让会话事件在加载时
      // 校验失败（"message has invalid content"），整个会话被判定为损坏并隔离。
      message = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'memory-file', scope: 'injected' },
      });
    } catch {
      // 构造失败就放弃注入，绝不影响正常对话。
      return decision;
    }
    if (!Array.isArray(decision.messages)) return decision;
    return { ...decision, messages: [...decision.messages, message] };
  });

  // ─────────────────────────────────────────────────────────────
  // 2) 工具：让 agent 能读、写、搜索、列出、撤销、处理待审（全部是文件操作）
  // ─────────────────────────────────────────────────────────────
  const memoryAdd = defineTool({
    name: 'memory_add',
    description:
      '把一条值得长期记住的事实写进用户记忆文件（明文 Markdown）。默认直接写入；写前会把原文件整份备份到同目录 backup/，可用 memory_undo 撤回。拿不准的（低置信、需用户确认）用 pending=true 放进待审队列，别直接写进记忆。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的一条事实，一句话说清。' },
      scope: { type: 'string', description: "写入位置：'workspace'（默认，当前工作区）或 'global'（所有工作区共享）。" },
      date: { type: 'string', description: '可选的日期前缀，格式 YYYY-MM-DD。' },
      source: { type: 'string', description: '可选来源：用户原话或出处，写进条目的「（来源：…）」。' },
      pending: { type: 'boolean', description: 'true = 只放进待审队列（MEMORY.pending.md），不写进记忆文件。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          added: { type: 'string', required: true },
          backup: { type: 'string', required: true },
          pending: { type: 'boolean', required: true },
        },
      },
      // render 是 ToolOutputDefinition 的**必填**字段：dsh-tools 的 defineTool 会无条件
      // 包装 options.output.render，漏掉它就会在渲染工具结果时抛
      // "output.render failed: userRender is not a function"。每个工具都必须给。
      render: (_args, value) => [
        {
          type: 'text',
          text: value.pending
            ? `已放进待审队列 ${value.file}\n${value.added}`
            : `已写入 ${value.file}\n${value.added}${value.backup ? `\n备份：${value.backup}` : ''}`,
        },
      ],
    },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const scope = args.scope === 'global' ? 'global' : 'workspace';
      const { file, pendingFile } = targetFor(paths, scope);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : todayLocal();
      const source = String(args.source || '').replace(/\s+/g, ' ').trim();
      const body = String(args.text).replace(/\r?\n/g, ' ').trim();
      const entry = `[${date}] ${body}${source ? `（来源：${source}）` : ''}`;

      if (args.pending === true) {
        appendPending(pendingFile, entry);
        return { file: pendingFile, added: `- [ ] ${entry}`, backup: '', pending: true };
      }

      mkdirSync(dirname(file), { recursive: true });
      const backup = backupBeforeWrite(file, scope);
      if (!existsSync(file)) writeFileSync(file, `# 记忆\n\n`, 'utf8');
      appendFileSync(file, `- ${entry}\n`, 'utf8');
      return { file, added: `- ${entry}`, backup, pending: false };
    },
    presentCall: (args) => ({ card: 'generic', title: args.pending ? '写入待审' : '写入记忆', kind: 'write', rawInput: args.text }),
  });

  const memoryRecall = defineTool({
    name: 'memory_recall',
    description: '在用户记忆文件里按关键词做纯文本搜索，返回匹配到的行。多个关键词之间是「与」关系。',
    parameters: {
      terms: { type: 'string', required: true, description: '空格分隔的关键词，例如 "相机 镜头"。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hits: { type: 'array', items: { type: 'string' }, required: true }, scanned: { type: 'array', items: { type: 'string' }, required: true } } },
      render: (_args, value) => {
        if (value.hits.length === 0) {
          return [{ type: 'text', text: value.scanned.length ? `未命中。已扫描：\n${value.scanned.join('\n')}` : '未命中：没有可读的记忆文件。' }];
        }
        return [{ type: 'text', text: `命中 ${value.hits.length} 行：\n${value.hits.map((h) => h.trim()).join('\n')}` }];
      },
    },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const terms = String(args.terms).split(/\s+/).filter(Boolean);
      const hits = [];
      const scanned = [];
      for (const file of [paths.global, paths.workspace].filter(Boolean)) {
        const text = readIfExists(file);
        if (text === undefined) continue;
        scanned.push(file);
        hits.push(...searchLines(text, terms));
      }
      return { hits: hits.slice(0, 200), scanned };
    },
  });

  const memoryList = defineTool({
    name: 'memory_list',
    description: '列出记忆文件的位置、大小与修改时间（并报告备份数量与待审条数），便于用户核对插件到底读了什么。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {},
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.map((f) => {
          if (!f.exists) return `${f.scope}: ${f.file}\n  （不存在）`;
          const pct = (f.bytes / maxBytes) * 100;
          return `${f.scope}: ${f.file}\n  ${formatBytes(f.bytes)} / 上限 ${formatBytes(maxBytes)}（${pct.toFixed(1)}%）· 修改于 ${f.modifiedAt}\n  备份 ${f.backups} 份 · 待审 ${f.pendingOpen} 条`;
        }).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const paths = pathsFor(exec?.agent);
      const files = [];
      for (const [scope, file] of [['global', paths.global], ['workspace', paths.workspace]]) {
        if (!file) continue;
        const side = sidecarPaths(file);
        const pendingText = readIfExists(side.pendingFile);
        const pendingOpen = pendingText === undefined ? 0 : parsePending(pendingText).open.length;
        if (!existsSync(file)) {
          files.push({ scope, file, exists: false, backups: 0, pendingOpen });
          continue;
        }
        const st = statSync(file);
        files.push({
          scope,
          file,
          exists: true,
          bytes: st.size,
          modifiedAt: st.mtime.toISOString(),
          backups: listBackups(file, scope).length,
          pendingOpen,
        });
      }
      return { files };
    },
  });

  const memoryUndo = defineTool({
    name: 'memory_undo',
    description:
      '撤回最近一次写入：把记忆文件恢复成最近一次写入之前的整份内容（写前自动留的备份）。注意它会一并丢弃那之后的所有改动，包括用户手写的。想先看有哪些备份，用 list=true。',
    parameters: {
      scope: { type: 'string', description: "'workspace'（默认）或 'global'。" },
      list: { type: 'boolean', description: 'true = 只列出可用备份，不做恢复。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          file: { type: 'string', required: true },
          backup: { type: 'string', required: true },
          backups: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'listed') {
          if (value.backups.length === 0) return [{ type: 'text', text: `${value.file}\n没有可用备份（说明这个记忆文件还没被本插件写过）。` }];
          return [{ type: 'text', text: `${value.file}\n可用备份 ${value.backups.length} 份（最近在前）：\n${value.backups.join('\n')}` }];
        }
        return [{ type: 'text', text: `已恢复：${value.file}\n取自备份：${value.backup}\n（该备份之后的所有改动，包括手写内容，都已丢弃。）` }];
      },
    },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const scope = args.scope === 'global' ? 'global' : 'workspace';
      const { file } = targetFor(paths, scope);

      if (args.list === true) {
        return { mode: 'listed', file, backup: '', backups: listBackups(file, scope).map((b) => b.file) };
      }

      const backup = latestBackup(file, scope);
      if (!backup) throw new Error(`没有可用备份（${file} 还没被本插件写过）。`);
      const content = readFileSync(backup, 'utf8');
      writeFileSync(file, content, 'utf8');
      logUndo(file, scope, backup.split(/[\\/]/).pop(), Buffer.byteLength(content, 'utf8'));
      return { mode: 'restored', file, backup, backups: [] };
    },
  });

  const memoryPending = defineTool({
    name: 'memory_pending',
    description:
      '处理待审队列（记忆文件同目录的 MEMORY.pending.md）：list 列出待确认条目；accept 把第 N 条收进记忆文件（写前备份）；drop 把第 N 条标记丢弃。低置信的事实走这里，别直接写进记忆。',
    parameters: {
      action: { type: 'string', required: true, description: "'list' | 'accept' | 'drop'。" },
      scope: { type: 'string', description: "'workspace'（默认）或 'global'。" },
      index: { type: 'number', description: 'accept / drop 时的条目序号（从 1 开始，来自 list 的输出）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          file: { type: 'string', required: true },
          memoryFile: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          entry: { type: 'string', required: true },
          backup: { type: 'string', required: true },
          resolved: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'listed') {
          if (value.entries.length === 0) {
            return [{ type: 'text', text: `${value.file}\n待审队列为空（已处理 ${value.resolved} 条）。` }];
          }
          return [{
            type: 'text',
            text: `${value.file}\n待审 ${value.entries.length} 条（已处理 ${value.resolved} 条）：\n${value.entries.map((e) => `  ${e.index}. ${e.text}`).join('\n')}`,
          }];
        }
        if (value.mode === 'accepted') {
          return [{ type: 'text', text: `已收进记忆：${value.memoryFile}\n${value.entry}${value.backup ? `\n备份：${value.backup}` : ''}` }];
        }
        return [{ type: 'text', text: `已丢弃待审条目：${value.entry}` }];
      },
    },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const scope = args.scope === 'global' ? 'global' : 'workspace';
      const { file: memoryFile, pendingFile } = targetFor(paths, scope);
      const text = readIfExists(pendingFile);
      const parsed = parsePending(text);

      if (args.action === 'list') {
        return {
          mode: 'listed',
          file: pendingFile,
          memoryFile,
          entries: parsed.open.map((e) => ({ index: e.index, text: e.text })),
          entry: '',
          backup: '',
          resolved: parsed.resolved,
        };
      }

      const index = Number(args.index);
      const target = parsed.open.find((e) => e.index === index);
      if (!target) throw new Error(`待审队列里没有第 ${args.index} 条（当前待审 ${parsed.open.length} 条）。先 list 看看。`);

      if (args.action === 'drop') {
        markPending(pendingFile, text, target, '-');
        return { mode: 'dropped', file: pendingFile, memoryFile, entries: [], entry: target.text, backup: '', resolved: parsed.resolved + 1 };
      }

      if (args.action !== 'accept') throw new Error(`未知 action：${args.action}（应为 list / accept / drop）。`);

      mkdirSync(dirname(memoryFile), { recursive: true });
      const backup = backupBeforeWrite(memoryFile, scope);
      if (!existsSync(memoryFile)) writeFileSync(memoryFile, `# 记忆\n\n`, 'utf8');
      appendFileSync(memoryFile, `- ${target.text}\n`, 'utf8');
      markPending(pendingFile, text, target, 'x');
      return { mode: 'accepted', file: pendingFile, memoryFile, entries: [], entry: target.text, backup, resolved: parsed.resolved + 1 };
    },
  });

  const memoryScan = defineTool({
    name: 'memory_scan',
    description:
      '查看/处理「新对话待合并」队列（autoScan）：status 看有没有待处理发言，preview 列出原话，scan 立即扫描一次会话日志，ack 推进游标（表示已处理完）。autoScan 默认为关闭，此时 pre-step 不会自动扫描，scan 就是手动触发的入口。',
    parameters: {
      action: { type: 'string', required: true, description: "'status' | 'preview' | 'scan' | 'ack'。" },
      scope: { type: 'string', description: "'workspace'（默认）或 'global'。" },
      limit: { type: 'number', description: 'preview 最多列出几条，默认 20。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          memoryFile: { type: 'string', required: true },
          pending: { type: 'number', required: true },
          added: { type: 'number', required: true },
          acked: { type: 'number', required: true },
          scanned: { type: 'number', required: true },
          turns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                time: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.turns.length
          ? `待合并 ${value.pending} 条（autoScan ${value.enabled ? '已开启' : '关闭'}）：\n${value.turns.map((t) => `  ${t.index}. [${t.time}] ${t.text}`).join('\n')}`
          : `待合并 ${value.pending} 条（autoScan ${value.enabled ? '已开启' : '关闭'}）· 本次新增 ${value.added} 条 · 本次 ack ${value.acked} 条 · 已去重 ${value.scanned} 条\n状态文件：${value.file}`,
      }],
    },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const scope = args.scope === 'global' ? 'global' : 'workspace';
      const { file: memoryFile, scanStateFile } = targetFor(paths, scope);
      const state = loadScanState(scanStateFile);
      const action = String(args.action || 'status').toLowerCase();
      let added = 0;
      let acked = 0;

      if (action === 'scan') {
        added = scanNewTurns(scanHome, state).length;
        saveScanState(scanStateFile, state);
      } else if (action === 'ack') {
        acked = state.turns.length;
        state.turns = [];
        saveScanState(scanStateFile, state);
      } else if (action !== 'status' && action !== 'preview') {
        throw new Error(`未知 action：${args.action}（应为 status / preview / scan / ack）。`);
      }

      const limit = Number.isFinite(args.limit) ? Math.max(1, args.limit) : 20;
      const turns = (action === 'preview' ? state.turns.slice(-limit) : []).map((t, i) => ({
        index: i + 1,
        time: t.time ? new Date(t.time).toISOString().slice(0, 10) : '日期不详',
        text: String(t.text).replace(/\s+/g, ' ').slice(0, 200),
      }));

      return {
        action,
        enabled: autoScan,
        file: scanStateFile,
        memoryFile,
        pending: state.turns.length,
        added,
        acked,
        scanned: Object.keys(state.seen).length,
        turns,
      };
    },
  });

  const memoryStatus = defineTool({
    name: 'memory_status',
    description:
      '报告「记忆看守」状态：DSH_HOME 指向哪里、当前 home 有多少会话、是否存在散落在别处的会话备份、两个记忆文件是否就位。用于发现「历史对话突然看不到」这类目录漂移问题。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { dshHome: { type: 'string', required: true }, sessions: { type: 'object', additionalProperties: true, required: true }, memoryFiles: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true }, backups: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `DSH_HOME: ${value.dshHome}`,
          `会话: ${value.sessions.total} 条（${value.sessions.buckets.length} 个工作区桶）`,
          ...value.memoryFiles.map((f) => `记忆(${f.scope}): ${f.exists ? `${f.file} · ${formatBytes(f.bytes)}` : `${f.file}（不存在）`}`),
          `同级其它 home/backup: ${value.backups.length ? value.backups.map((b) => b.path).join(' · ') : '无'}`,
        ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const paths = pathsFor(exec?.agent);
      const home = process.env.DSH_HOME || join(homedir(), '.dsh');

      // 会话统计（只 stat，不读内容）
      const sessionsDir = join(home, 'sessions');
      const buckets = [];
      let total = 0;
      try {
        // [audit:readdir] 枚举 $DSH_HOME/sessions 下的工作区桶目录名（不读会话文件内容）
        for (const e of readdirSync(sessionsDir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const dir = join(sessionsDir, e.name);
          let n = 0;
          // [audit:readdir] 枚举桶下的会话目录名
          for (const s of readdirSync(dir, { withFileTypes: true })) {
            if (!s.isDirectory()) continue;
            // [audit:readdir] 枚举会话目录下的文件名，只做正则计数，不读内容
            for (const f of readdirSync(join(dir, s.name))) {
              if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(f)) n++;
            }
          }
          total += n;
          buckets.push({ workspace: e.name, sessions: n });
        }
      } catch { /* home 不可读就留空 */ }

      // 找同级的其它 home 目录（重装/换目录后旧数据常留在这里）
      const backups = [];
      try {
        const parent = dirname(resolve(home));
        // [audit:readdir] 枚举 $DSH_HOME 的同级目录名，寻找旧 home/backup
        for (const e of readdirSync(parent, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const cand = join(parent, e.name);
          if (cand === resolve(home)) continue;
          for (const sub of ['home', 'backup', 'sessions']) {
            const p = join(cand, sub);
            if (existsSync(p) && statSync(p).isDirectory()) {
              backups.push({ path: p, looksLikeOtherHome: sub === 'home' || sub === 'sessions' });
            }
          }
        }
      } catch { /* 父目录不可读就跳过 */ }

      const memoryFiles = [];
      for (const [scope, file] of [['global', paths.global], ['workspace', paths.workspace]]) {
        if (!file) continue;
        if (!existsSync(file)) { memoryFiles.push({ scope, file, exists: false }); continue; }
        const st = statSync(file);
        memoryFiles.push({ scope, file, exists: true, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }

      return { dshHome: home, sessions: { total, buckets }, memoryFiles, backups };
    },
  });

  // 注册工具。注册失败必须可见——静默吞掉会让「工具不工作」变成一个查不出的谜。
  const toolset = [memoryAdd, memoryRecall, memoryList, memoryUndo, memoryPending, memoryScan, memoryStatus];
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(
      'memory-file: ctx.tools 不可用，工具未注册。请在插件里保持 `export const inject = [\'tools\']`。',
    );
  }
  for (const tool of toolset) ctx.tools.register(tool);
}
