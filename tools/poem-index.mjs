#!/usr/bin/env node
/**
 * ── 扫描语料库生成清单 → blog-comments/poems/index.json ──
 *
 * 语料结构（2026-11-03 定稿，每作者两文件）：
 *   poems/{zh/classical/{朝代}|zh/modern|en|de}/{作者}/poems.json  全部诗一个数组
 *   poems/{…}/{作者}/author.json                                   作者简介
 * 索引按"作者"粒度记 {file, count}，选诗方（fetch-poem.mjs / batch-poems.mjs）
 * 先按 hash(日期) 均匀抽作者、再按二级哈希抽篇——白居易千余首不会挤掉王昌龄
 * 二十一首。路径一律默认 sort()（字节序，跨机器稳定），不用 localeCompare。
 *
 * 本脚本住 blog-comments/tools/，默认扫本仓库的 poems/。语料任何增删改之后
 * 重跑本脚本，然后 commit + push。
 * 用法（在 blog-comments 仓库根目录）：node tools/poem-index.mjs
 */
'use strict';

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 桶 → (目录前缀, 需下钻几层到作者目录)：zh/classical 隔着朝代一层，
 * zh/modern 2026-11-03 起也隔一层——流派（14 派，名单见 harvest-poetry-sheepzh.mjs 的 POETS 表） */
const BUCKETS = [
    ['zhClassical', 'zh/classical', 1],
    ['zhModern', 'zh/modern', 1],
    ['en', 'en', 0],
    ['de', 'de', 0],
];

async function main() {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outArg = outIdx > -1 ? args[outIdx + 1] : '.'; // --out 相对 blog-comments 仓库根
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', outArg);
    const poemsDir = path.join(root, 'poems');

    const buckets = {};
    for (const [key, prefix, depth] of BUCKETS) {
        const found = [];
        const collect = async (d, left) => {
            let entries;
            try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                if (left === 0) found.push(path.join(d, e.name));
                else await collect(path.join(d, e.name), left - 1);
            }
        };
        await collect(path.join(poemsDir, prefix), depth);

        const authors = [];
        for (const dir of found.sort()) {
            const file = path.join(dir, 'poems.json');
            try {
                const data = JSON.parse(await readFile(file, 'utf8'));
                if (Array.isArray(data.poems) && data.poems.length) {
                    authors.push({ file: path.relative(poemsDir, file).replace(/\\/g, '/'), count: data.poems.length });
                }
            } catch (err) {
                console.warn(`  跳过坏文件 ${file}：${err.message}`);
            }
        }
        buckets[key] = authors;
    }

    const totals = Object.fromEntries(Object.entries(buckets)
        .map(([k, v]) => [k, v.reduce((s, a) => s + a.count, 0)]));
    const index = {
        generatedAt: new Date().toISOString(),
        totals,
        authorsPerBucket: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
        buckets,
    };
    await writeFile(path.join(poemsDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
    console.log(`poems/index.json：`,
        Object.entries(buckets).map(([k, v]) => `${k} ${v.length} 位作者/${v.reduce((s, a) => s + a.count, 0)} 首`).join(' · '));
}

main().catch(err => {
    console.error('生成索引失败：', err.message);
    process.exit(1);
});
