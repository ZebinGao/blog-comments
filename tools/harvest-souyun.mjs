#!/usr/bin/env node
/**
 * ── 一次性收割：搜韵 32 位诗人 → blog-comments/poems/zh/classical/{朝代}/{作者}/ ──
 *
 * 语料库改放公共仓库 blog-comments（2026-11-03 定稿）后，中文古典不再每天调搜韵
 * 接口，而是收割一次入库。文本以搜韵 CSV 为准（与原 fetch-poem.mjs 在线选诗同源，
 * 不存在记忆录入的错字风险）；过滤也同原脚本：体裁带诗/词/曲/歌/吟/行/府 的韵文，
 * 篇幅 8–240 字。朝代目录用池子里的粗朝代（汉/唐/五代/宋/金/元/清）。
 * 每作者两文件（2026-11-03 结构）：poems.json（全部诗一个数组）+ author.json
 * （已存在则不动，新增作者只写占位，简介去 blog-comments 手补）。
 *
 * 幂等可重跑：poems.json 整文件覆盖。用法（本脚本住 blog-comments/tools/，默认就写本仓库）：
 *   node tools/harvest-souyun.mjs
 * （国内接口直连即可，无需代理；收割完记得 node tools/poem-index.mjs 重建索引）
 */
'use strict';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POETS = [
    ['唐', '李白'], ['唐', '杜甫'], ['唐', '王维'], ['唐', '白居易'], ['唐', '李商隐'],
    ['唐', '杜牧'], ['唐', '孟浩然'], ['唐', '王昌龄'], ['唐', '刘禹锡'], ['唐', '柳宗元'],
    ['宋', '苏轼'], ['宋', '陆游'], ['宋', '辛弃疾'], ['宋', '李清照'], ['宋', '王安石'],
    ['宋', '欧阳修'], ['宋', '黄庭坚'], ['宋', '范成大'], ['宋', '杨万里'],
    ['清', '纳兰性德'], ['清', '龚自珍'],
    ['汉', '曹操'], ['唐', '王勃'], ['唐', '李贺'], ['五代', '李煜'], ['金', '元好问'],
    ['元', '马致远'], ['元', '张养浩'], ['元', '白朴'], ['清', '郑燮'], ['清', '袁枚'],
    ['清', '黄景仁'],
];

const API = 'https://open.cnkgraph.com/api/Writing';

async function fetchText(url, timeoutMs = 60000) {
    let lastErr;
    for (let i = 1; i <= 3; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'zebin-blog-poem-harvester', 'Accept-Language': 'zh-cn' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return await res.text();
        } catch (err) {
            lastErr = err;
            console.warn(`  第 ${i} 次尝试失败：${err.message}`);
            if (i < 3) await new Promise(r => setTimeout(r, i * 2000));
        }
    }
    throw lastErr;
}

/* 同 fetch-poem.mjs 的极简 CSV 解析 */
function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch !== '\r') field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/* 分句拼行（同 fetch-poem.mjs）：句末标点收口，长句 40 字兜底换行 */
function clauseLines(content) {
    const pieces = String(content || '').match(/[^。；！？]*[。；！？]+|[^。；！？]+/g) || [];
    const lines = [];
    let buf = '';
    for (const p of pieces) {
        buf += p;
        if (/[。；！？]$/.test(p) || buf.length > 40) { lines.push(buf); buf = ''; }
    }
    if (buf) lines.push(buf);
    return lines;
}

/* Windows/Linux 目录名都安全：去非法字符、压空白、限长 */
function safeDir(name) {
    return String(name).replace(/[<>:"/\\|?*·]/g, '·').replace(/\s+/g, '-').slice(0, 60) || '佚名';
}

async function main() {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outArg = outIdx > -1 ? args[outIdx + 1] : '.'; // --out 相对 blog-comments 仓库根
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', outArg);
    const base = path.join(root, 'poems', 'zh', 'classical');

    let total = 0, totalBytes = 0;
    for (const [dynasty, author] of POETS) {
        const csv = await fetchText(`${API}/${encodeURIComponent(dynasty)}/${encodeURIComponent(author)}`);
        const rows = parseCsv(csv);
        const head = rows.shift() || [];
        const col = name => head.indexOf(name);
        const [cTitle, cType, cContent] = ['标题', '体裁', '内容'].map(col);
        const isVerse = t => /[诗词曲歌吟行府]/.test(t || '');
        const pool = rows.filter(r =>
            isVerse(r[cType]) && r[cTitle] && r[cContent]
            && r[cContent].length >= 8 && r[cContent].length <= 240);

        const dir = path.join(base, safeDir(dynasty), safeDir(author));
        await mkdir(dir, { recursive: true });
        const poems = pool.map(r => ({
            title: r[cTitle].trim(),
            type: (r[cType] || '').trim(),
            stanzas: [clauseLines(r[cContent]).join('\n')],
        }));
        const text = JSON.stringify({ author, poems }, null, 2) + '\n';
        await writeFile(path.join(dir, 'poems.json'), text, 'utf8');
        try {
            await writeFile(path.join(dir, 'author.json'), JSON.stringify({ author }, null, 2) + '\n',
                { flag: 'wx' }); // 已存在（含手补简介）不覆盖
        } catch (e) { /* EEXIST 属预期 */ }
        totalBytes += text.length;
        total += pool.length;
        console.log(`  ${dynasty}·${author}：${pool.length} 首`);
    }
    console.log(`合计 ${total} 首 → ${base}（约 ${(totalBytes / 1024).toFixed(0)} KB JSON）`);
    console.log('注意：新增/删除文件后需重跑 tools/poem-index.mjs 生成 poems/index.json');
}

main().catch(err => {
    console.error('收割搜韵失败：', err.message);
    process.exit(1);
});
