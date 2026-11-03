#!/usr/bin/env node
/**
 * ── 一次性收割：PoetryDB 16 位作者 → blog-comments/poems/en/{作者}/ ──
 *
 * 英文语料同样改入库（公共仓库 blog-comments），每日选诗不再调 PoetryDB。
 * 作者名单 2026-11-03 对照 poetrydb.org/author 全量表逐一验活（129 人中挑的）；
 * 过滤同 fetch-poem.mjs：行数 4–24，剔掉长叙事诗。文本以 PoetryDB 为准。
 * 每作者两文件（2026-11-03 结构）：poems.json（全部诗一个数组）+ author.json
 * （已存在则不动，新增作者只写占位）。单个作者拉挂（PoetryDB 偶发 503）跳过
 * 不炸整体，重跑即补。
 *
 * 幂等可重跑。用法（本脚本住 blog-comments/tools/，默认就写本仓库；本地需代理）：
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node tools/harvest-poetrydb.mjs
 * （收割完记得 node tools/poem-index.mjs 重建索引）
 */
'use strict';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POETS = [
    'William Shakespeare', 'William Blake', 'William Wordsworth', 'John Keats',
    'Percy Bysshe Shelley', 'George Gordon, Lord Byron', 'John Donne', 'Robert Burns',
    'Emily Dickinson', 'Edgar Allan Poe', 'Christina Rossetti', 'Samuel Coleridge',
    'Edward Lear', 'Lewis Carroll', 'Andrew Marvell', 'Robert Herrick',
];

const API = 'https://poetrydb.org/author/';

async function getJson(url, timeoutMs = 60000) {
    let lastErr;
    for (let i = 1; i <= 4; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'zebin-blog-poem-harvester' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return await res.json();
        } catch (err) {
            lastErr = err;
            console.warn(`  第 ${i} 次尝试失败：${err.message}`);
            if (i < 4) await new Promise(r => setTimeout(r, i * 5000)); // 503 过载：长退避
        }
    }
    throw lastErr;
}

/* lines 一维数组、空串分节 → stanzas（同 fetch-poem.mjs） */
function stanzasFromLines(lines) {
    const stanzas = [];
    let cur = [];
    for (const l of lines) {
        if (l.trim() === '') {
            if (cur.length) { stanzas.push(cur.join('\n')); cur = []; }
        } else cur.push(l.trim());
    }
    if (cur.length) stanzas.push(cur.join('\n'));
    return stanzas;
}

/* Windows/Linux 目录名都安全：去非法字符、压空白、限长 */
function safeDir(name) {
    return String(name).replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

async function main() {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outArg = outIdx > -1 ? args[outIdx + 1] : '.'; // --out 相对 blog-comments 仓库根
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', outArg);
    const base = path.join(root, 'poems', 'en');

    let total = 0, totalBytes = 0;
    const failed = [];
    for (const author of POETS) {
        let works;
        try {
            works = await getJson(API + encodeURIComponent(author));
        } catch (err) {
            // 单个作者挂了不炸整个收割：记下来最后汇报，重跑本脚本会接着补（幂等覆盖）
            console.warn(`  ${author} 拉取失败（${err.message}），跳过`);
            failed.push(author);
            continue;
        }
        if (!Array.isArray(works)) { console.warn(`  ${author} 返回不是作品数组，跳过`); failed.push(author); continue; }
        const pool = works.filter(p =>
            p.title && Array.isArray(p.lines)
            && +p.linecount >= 4 && +p.linecount <= 24);

        const dir = path.join(base, safeDir(author));
        await mkdir(dir, { recursive: true });
        const poems = pool.map(w => ({ title: w.title.trim(), stanzas: stanzasFromLines(w.lines) }));
        const text = JSON.stringify({ author, poems }, null, 2) + '\n';
        await writeFile(path.join(dir, 'poems.json'), text, 'utf8');
        try {
            await writeFile(path.join(dir, 'author.json'), JSON.stringify({ author }, null, 2) + '\n',
                { flag: 'wx' }); // 已存在（含手补简介）不覆盖
        } catch (e) { /* EEXIST 属预期 */ }
        totalBytes += text.length;
        total += pool.length;
        console.log(`  ${author}：${pool.length} 首`);
    }
    console.log(`合计 ${total} 首 → ${base}（约 ${(totalBytes / 1024).toFixed(0)} KB JSON）`);
    if (failed.length) console.warn(`以下作者未收割（重跑本脚本即可补，幂等覆盖）：${failed.join('、')}`);
    console.log('注意：新增/删除文件后需重跑 tools/poem-index.mjs 生成 poems/index.json');
}

main().catch(err => {
    console.error('收割 PoetryDB 失败：', err.message);
    process.exit(1);
});
