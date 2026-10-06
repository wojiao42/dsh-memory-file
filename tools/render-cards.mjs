#!/usr/bin/env node
/**
 * 生成插件市场商店页用的「效果示意图」。
 *
 *   node tools/render-cards.mjs
 *
 * 为什么是"示意图"而不是截图：dsh-memory-file 是 **host 侧插件，没有界面**，
 * 没有可以截的真实 GUI。所以这里做的是把插件**实际产生的那三段文本**
 * （会话里看到的注入块、autoScan 的待合并提示、磁盘上的写入留痕）排版成图，
 * 并且每张图都带「示意图」角标 —— 不假装成界面截图。
 *
 * ⚠️ 图中的路径、文件名、记忆内容**全部是虚构样本**，不含任何真实用户数据。
 *
 * 产出：assets/screenshot-1-injection.png、-2-autoscan.png、-3-audit.png
 * （已在仓库里；只有要改图时才需要重跑，且需要本机有 Chrome 或 Edge。）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assets = path.join(root, 'assets');

const WIDTH = 1200;
const HEIGHT = 720;

/** 找本机可用的 Chromium 系浏览器。 */
function findBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((candidate) => candidate !== '' && fs.existsSync(candidate));
}

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 一张卡片的完整 HTML。 */
function cardHtml({ title, subtitle, body, theme = 'dark' }) {
  const dark = theme === 'dark';
  const palette = dark
    ? { bg: '#0e1116', card: '#161a22', border: '#252b36', text: '#e7eaf0', dim: '#98a2b3', code: '#0b0e13', accent: '#6ea8ff' }
    : { bg: '#f4f6f9', card: '#ffffff', border: '#e2e6ee', text: '#1d2330', dim: '#64707f', code: '#f7f9fc', accent: '#2b6cb0' };
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    background: ${palette.bg}; color: ${palette.text};
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    width: ${WIDTH - 64}px; background: ${palette.card};
    border: 1px solid ${palette.border}; border-radius: 14px; overflow: hidden;
    box-shadow: 0 18px 50px rgba(0,0,0,${dark ? '0.45' : '0.10'});
  }
  .bar {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 20px; border-bottom: 1px solid ${palette.border};
  }
  .dots { display: flex; gap: 7px; }
  .dots i { width: 11px; height: 11px; border-radius: 50%; background: ${palette.border}; display: block; }
  .bar .t { font-size: 15px; font-weight: 600; }
  .bar .s { font-size: 13px; color: ${palette.dim}; margin-left: auto; }
  .tag {
    margin: 16px 20px 0; padding: 7px 12px; border-radius: 8px; font-size: 13px;
    color: #ffd76a; background: rgba(255, 193, 7, 0.10); border: 1px solid rgba(255, 193, 7, 0.35);
  }
  .body { padding: 14px 20px 22px; }
  pre {
    margin: 0; padding: 16px 18px; border-radius: 10px; background: ${palette.code};
    border: 1px solid ${palette.border}; font-family: Consolas, "Cascadia Mono", monospace;
    font-size: 14.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word;
  }
  .k { color: ${palette.accent}; }
  .d { color: ${palette.dim}; }
  .w { color: #ffd76a; }
  .g { color: #7ee2a8; }
</style></head>
<body><div class="card">
  <div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="t">${esc(title)}</span><span class="s">${esc(subtitle)}</span></div>
  <div class="tag">示意图 · 非真实界面截图；图中路径与内容均为虚构样本</div>
  <div class="body"><pre>${body}</pre></div>
</div></body></html>`;
}

const cards = [
  {
    file: 'screenshot-1-injection.png',
    title: 'dsh-memory-file · 每个会话开始注入记忆',
    subtitle: '会话首次 pre-step',
    theme: 'dark',
    body: [
      '<span class="d">&lt;system-reminder&gt;</span>',
      '以下是用户长期记忆文件的内容。它是用户自己维护的明文笔记，请作为背景参考。',
      '',
      '<span class="d">&lt;!-- scope: 全局 (C:\\work\\home\\memory\\MEMORY.md) --&gt;</span>',
      '<span class="k"># 记忆</span>',
      '- [2026-10-02] 喜欢简洁的回答，不要导语（来源：用户原话）',
      '- 每周三晚上有固定安排',
      '',
      '<span class="d">&lt;!-- scope: 工作区 (D:\\work\\my-project\\.dsh\\memory\\MEMORY.md) --&gt;</span>',
      '<span class="k"># 工作区记忆</span>',
      '- 这个项目用 pnpm + Node 20',
      '<span class="d">&lt;/system-reminder&gt;</span>',
      '',
      '<span class="g">同一会话只注入一次</span>；之后每一轮都在同一上下文里，不重复烧 token。',
    ].join('\n'),
  },
  {
    file: 'screenshot-2-autoscan.png',
    title: 'autoScan · 把「新对话」摆到 agent 面前（默认关闭）',
    subtitle: '每次会话首次 pre-step 顺带扫描',
    theme: 'dark',
    body: [
      '<span class="d">&lt;!-- autoScan：新对话待合并（共 12 条，下面是最新的 30 条） --&gt;</span>',
      '以下是<span class="w">你自己</span>最近在对话里说过的话（取自本机会话日志）：',
      '',
      '1. [2026-10-06] 我想改成每天 21 点跑',
      '2. [2026-10-06] 这个库还是用 Node 20 吧',
      '3. [2026-10-06] 以后回答别写导语',
      '',
      '请判断其中有没有<span class="w">关于你的持久事实</span>：',
      '  · 有把握的 → <span class="k">memory_add</span>（带上 source）',
      '  · 拿不准的 → <span class="k">memory_add(pending: true)</span> 进待审',
      '  · 都没有 → 直接结束，不要为了凑数写',
      '处理完调用 <span class="k">memory_scan</span>（action: ack）推进游标。',
      '',
      '<span class="d">只认带 source.clientTimeZone 的 user/message —— 运行时注入不算人说的。</span>',
    ].join('\n'),
  },
  {
    file: 'screenshot-3-audit.png',
    title: '写入留痕 · 每次写入前留一份整份快照',
    subtitle: '写错了可撤回',
    theme: 'light',
    body: [
      '<span class="k">D:\\work\\my-project\\.dsh\\memory\\</span>',
      '├─ MEMORY.md                                 4.5 KB   10-06 08:20:58',
      '├─ MEMORY.pending.md                         0.6 KB   10-06 08:20:55   <span class="d">待审 3 条</span>',
      '├─ .autoscan.json                            1.1 KB   10-06 08:21:02   <span class="d">已去重 215 条</span>',
      '└─ backup\\',
      '   ├─ MEMORY-workspace-20261006-082058208.md  4.4 KB  <span class="g">← 那次写入前的整份快照</span>',
      '   ├─ MEMORY-workspace-20261005-183553117.md  4.3 KB',
      '   └─ undo.log                                0.2 KB  <span class="d">每次 memory_undo 追一行</span>',
      '',
      '<span class="d">文件名里的时间戳 = 写入发生的时刻（写前才备份）。</span>',
      '想核对某次改了什么：把相邻两份快照 <span class="k">git diff --no-index</span> 一下。',
      '<span class="k">memory_undo</span> 一键回到最近一次写入前（会一并丢弃那之后的手改）。',
    ].join('\n'),
  },
];

const browser = findBrowser();
if (browser === undefined) {
  console.error('找不到 Chrome / Edge，无法出图。assets/ 里已有的 PNG 可以直接用。');
  process.exit(1);
}

fs.mkdirSync(assets, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memfile-cards-'));

for (const card of cards) {
  const htmlPath = path.join(tmp, `${card.file}.html`);
  const outPath = path.join(assets, card.file);
  fs.writeFileSync(htmlPath, cardHtml(card), 'utf8');
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${outPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90_000 },
  );
  const size = fs.statSync(outPath).size;
  console.log(`✔ ${path.relative(root, outPath)}  ${(size / 1024).toFixed(0)} KB`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('完成。记得同步 screenshots.json（1-8 张，相对路径）。');
