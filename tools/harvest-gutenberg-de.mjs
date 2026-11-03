#!/usr/bin/env node
/**
 * ── 一次性收割：Project Gutenberg 德语诗集三本 → poems/de/{姓}/ ──────────
 *
 * 德语没有 PoetryDB 那样的公版 API（TextGrid 的 TEI 接口摸不着、gutendex 不通），
 * 改从 PG 整本诗集收割。选书两条硬规：作者逝世满 70 年；排版可机读。
 * 2026-11-03 验证过的三本（TextGrid/莱比锡语料库两条路都探过，见会话记录）：
 *   #6649  Schiller《Einige Gedichte》  诗行缩进式，结构最干净
 *   #12268 Storm《Hohe Sommertage》      无缩进空行分块式；低地德语 9 首按目录排除
 *   #60522 Busch《Schein und Sein》      缩进式 + Fraktur 转录标记（_x_ / ~x~ 需清理）
 * Heine《Buch der Lieder》(#3498) 与 Goethe《West-östlicher Divan》(#2319) 都是
 * 无缩进式且错漏/歧义多，放弃——两位已有手录篇目。
 *
 * 解析（三本通用）：PG 头尾切掉后按空行切块，**单行块是标题、多行块是诗节**
 * （Schiller 那本连标题都缩进，不能用缩进判别；Storm 顶格式同理，两态归一）。
 * start 是各书正文起点（第一首诗的标题，目录里的同名行带页码、书名页不带句点，
 * 都不会精确匹配）；扫到尾部注释区（Anmerkungen 等）即停。块内纯数字行（Busch
 * 目录区的年份）剔除。过滤：4–24 行（同英文闸），skipTitles 排除低地德语等。
 *
 * 幂等可重跑（每次重拉重解析，poems.json 覆盖，author.json 已存在不动）。
 * 用法（本仓库根目录，本地需代理）：
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node tools/harvest-gutenberg-de.mjs
 * （收割完记得 node tools/poem-index.mjs 重建索引）
 */
'use strict';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOKS = [
    {
        id: 6649, dir: 'Schiller', author: 'Friedrich Schiller', years: '1759–1805',
        start: 'Abschied vom Leser',
        intro: '德国古典戏剧与诗歌双峰之一，《欢乐颂》词作者，与歌德并称魏玛双璧。',
    },
    {
        id: 12268, dir: 'Storm', author: 'Theodor Storm', years: '1817–1888',
        start: 'Sommer',
        skipTitles: ['Steernkiker', 'Lengen', 'Verbaden Leev', 'An de Gorenport',
            "Go' Nach", 'Lütt Ursel', 'De Snurkers', "De lütt' Boom", 'De Stormfloth'], // 低地德语篇，对学习者过难
        intro: '诗意现实主义代表，《白马骑士》作者，抒情诗以月光、乡愁与暮色著称。',
    },
    {
        id: 60522, dir: 'Busch', author: 'Wilhelm Busch', years: '1832–1908',
        start: 'Schein und Sein.', // 带句点：书名页/目录里的同名行都不会精确匹配
        intro: '连环画诗《马克斯与莫里茨》作者，德语幽默打油诗一代宗师。',
    },
];

/* 尾部注释区：标题块匹配到这些开头就停（后面是校勘记/注释，不是诗） */
const STOP = /^(Anmerkung|Verbesserung|Druckfehler|Namen-?\s?verzeichnis|Register|Glossar|Transcriber|DAS ENDE|Ende)/i;

async function fetchText(url) {
    let lastErr;
    for (let i = 1; i <= 4; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (zebin-blog-poem-harvester)' },
                signal: AbortSignal.timeout(90000),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return await res.text();
        } catch (err) {
            lastErr = err;
            console.warn(`  第 ${i} 次尝试失败：${err.message}`);
            if (i < 4) await new Promise(r => setTimeout(r, i * 5000));
        }
    }
    throw lastErr;
}

/* Fraktur 转录标记清理：_gesperrt_ / ~Antiqua~ 去符号；压行内多余空白 */
const cleanLine = l => l
    .replace(/[_~]+(\S[^_~]*?)[_~]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/* 块解析 → [{title, stanzas}]。
 * 块 = 空行分隔的连续行；单行块是标题、多行块是诗节。 */
function parsePoems(body, book) {
    const lines = body.replace(/\r/g, '').split('\n');
    const blocks = [];
    let cur = [];
    for (const raw of lines) {
        if (raw.trim() === '') {
            if (cur.length) blocks.push(cur);
            cur = [];
        } else cur.push(raw);
    }
    if (cur.length) blocks.push(cur);

    const poems = [];
    let started = false, title = null, stanzas = [];
    const flush = () => {
        if (title && stanzas.length) poems.push({ title, stanzas });
        title = null; stanzas = [];
    };
    for (const blk of blocks) {
        const cleaned = blk
            .map(l => cleanLine(l.replace(/^(?:\[\w+[^\]]*\]|[-—*]\s*)+/, '')))
            .filter(l => l && !/^\d{1,4}[.:]?$/.test(l)); // 剔 [Illustration]/分隔线/纯数字（页码年份）
        if (!cleaned.length) continue; // 整块是装饰行
        if (!started) {
            if (cleaned.length === 1 && cleaned[0] === book.start) started = true; // 正文第一首的标题
            else continue; // 书名页/前言/目录区
        }
        if (cleaned.length === 1 && STOP.test(cleaned[0])) break; // 书尾注释区
        if (cleaned.length === 1) {
            flush();
            title = cleaned[0].replace(/\s+\d+\s*$/, ''); // 剥目录式页码残留
        } else {
            if (!title) continue; // 标题出现前的散块
            stanzas.push(cleaned.join('\n'));
        }
    }
    flush();
    return poems;
}

async function main() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const base = path.join(root, 'poems', 'de');

    let total = 0;
    for (const book of BOOKS) {
        const raw = await fetchText(`https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`);
        const s = raw.indexOf('*** START');
        const e = raw.indexOf('*** END');
        if (s < 0 || e < 0) throw new Error(`#${book.id} 找不到 PG 头尾标记`);
        const all = parsePoems(raw.slice(s, e), book);
        const skip = new Set(book.skipTitles || []);
        const pool = all.filter(p => {
            if (skip.has(p.title) || p.title.length > 60) return false; // 低地德语/章名等
            const nLines = p.stanzas.reduce((n, st) => n + st.split('\n').length, 0);
            if (nLines < 4 || nLines > 24) return false; // 篇幅闸同英文
            return /^[A-ZÄÖÜ„"'(]/.test(p.title) && !/^\d/.test(p.title);
        });

        const dir = path.join(base, book.dir);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'poems.json'),
            JSON.stringify({ author: book.author, poems: pool }, null, 2) + '\n', 'utf8');
        try {
            await writeFile(path.join(dir, 'author.json'), JSON.stringify({
                author: book.author, years: book.years, intro: book.intro,
            }, null, 2) + '\n', { flag: 'wx' }); // 已存在（手补简介）不覆盖
        } catch { /* EEXIST 属预期 */ }
        total += pool.length;
        console.log(`  ${book.dir}：解析 ${all.length} 首 → 入库 ${pool.length} 首（#${book.id}）`);
        const preview = pool.slice(0, 3).map(p => p.title).join(' / ');
        if (preview) console.log(`    预览：${preview}`);
    }
    console.log(`合计 ${total} 首 → ${base}`);
    console.log('注意：新增/删除文件后需重跑 tools/poem-index.mjs 生成 poems/index.json');
}

main().catch(err => {
    console.error('收割 Gutenberg 德语诗集失败：', err.message);
    process.exit(1);
});
