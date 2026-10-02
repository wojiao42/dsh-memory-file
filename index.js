/**
 * dsh-memory-file — 文件型长期记忆插件
 *
 * 设计约束（安全主张可被外部核实，请对照源码逐条检查）：
 *
 *   1. 不读对话。本文件唯一导入的运行时依赖是 `node:fs` / `node:path` / `node:os`。
 *      源码中不存在任何订阅消息内容的事件（如 `agent/message`、`user/message`）。
 *      唯一挂载的钩子是 `agent/pre-step`，且**只读取 agent 与会话 cwd**，不读 `messages` 的内容。
 *   2. 不联网。源码中不存在 `fetch` / `http` / `https` / `net` / `dns` / `tls` / WebSocket。
 *   3. 只读写两个路径下的 Markdown 文件（见 resolveMemoryPaths）。不触碰其他文件。
 *
 * 如果后续有人修改本文件，请同时修改 README 的「可核实约束」一节，并重新核对上述三条。
 * 违反上述任一条都应当被视为破坏性变更。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'memory-file';

/** 单个记忆文件的最大注入字节数，防止一条巨型记忆撑爆上下文。 */
const DEFAULT_MAX_BYTES = 16384;

/** 注入内容不得包含伪造的框架闭合标签。 */
const FRAMEWORK_CLOSE = '</system-reminder>';

function escapeFramework(text) {
  return text.split(FRAMEWORK_CLOSE).join('<\\/system-reminder>');
}

/**
 * 记忆文件的候选路径，按优先级排列（先全局后工作区）。
 * 只在这两个位置读写：
 *   - 全局：$DSH_HOME/memory/MEMORY.md（默认 ~/.dsh/memory/MEMORY.md）
 *   - 工作区：<cwd>/.dsh/memory/MEMORY.md
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

function readIfExists(file) {
  try {
    if (!existsSync(file)) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
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

export function apply(ctx, config = {}) {
  const maxBytes = Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES;
  const dshHome = config.dshHome;
  const header = config.header ?? '以下是用户长期记忆文件的内容。它是用户自己维护的明文笔记，请作为背景参考。';

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
  // 2) 工具：让 agent 能读、写、搜索、列出记忆（全部是文件操作）
  // ─────────────────────────────────────────────────────────────
  const memoryAdd = defineTool({
    name: 'memory_add',
    description:
      '把一条值得长期记住的事实追加到用户记忆文件（明文 Markdown）。用于用户明确要求记住、或确认了某个跨会话仍然成立的偏好/事实时。不要用它保存临时信息。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的一条事实，一句话说清。' },
      scope: { type: 'string', description: "写入位置：'workspace'（默认，当前工作区）或 'global'（所有工作区共享）。" },
      date: { type: 'string', description: '可选的日期前缀，格式 YYYY-MM-DD。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { file: { type: 'string', required: true }, added: { type: 'string', required: true } } } },
    async execute(args, exec) {
      const paths = pathsFor(exec?.agent);
      const file = args.scope === 'global' ? paths.global : paths.target;
      const line = `- ${args.date ? `[${args.date}] ` : ''}${String(args.text).replace(/\r?\n/g, ' ').trim()}`;
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, `# 记忆\n\n`, 'utf8');
      appendFileSync(file, line + '\n', 'utf8');
      return { file, added: line };
    },
    presentCall: (args) => ({ card: 'generic', title: '写入记忆', kind: 'write', rawInput: args.text }),
  });

  const memoryRecall = defineTool({
    name: 'memory_recall',
    description: '在用户记忆文件里按关键词做纯文本搜索，返回匹配到的行。多个关键词之间是「与」关系。',
    parameters: {
      terms: { type: 'string', required: true, description: '空格分隔的关键词，例如 "相机 镜头"。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { hits: { type: 'array', items: { type: 'string' }, required: true }, scanned: { type: 'array', items: { type: 'string' }, required: true } } } },
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
    description: '列出记忆文件的位置、大小与修改时间，便于用户核对插件到底读了什么。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } } } },
    async execute(_args, exec) {
      const paths = pathsFor(exec?.agent);
      const files = [];
      for (const [scope, file] of [['global', paths.global], ['workspace', paths.workspace]]) {
        if (!file) continue;
        if (!existsSync(file)) { files.push({ scope, file, exists: false }); continue; }
        const st = statSync(file);
        files.push({ scope, file, exists: true, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
      return { files };
    },
  });

  for (const tool of [memoryAdd, memoryRecall, memoryList]) {
    try {
      ctx.tools.register(tool);
    } catch {
      // 注册失败不应让宿主起不来。
    }
  }
}
