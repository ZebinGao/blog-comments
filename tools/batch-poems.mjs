#!/usr/bin/env node
/**
 * ── 批量预生成整月四页 → 本仓库 daily/{月}/{日期}.json ──────────
 *
 * 每月初本地跑一次（需 ZHIPU_API_KEY）：中文古典/现代逐日、英德按六天组各调
 * 一次 GLM 出注释（组内六天复用同一份，省 5/6 调用），把成品页原样存进本仓库
 * （blog-comments）。之后整月主仓 CI 的 fetch-poem.mjs 每天直接拉当日 JSON
 * 落盘——秒级出页、零 GLM、无需密钥。
 *
 * 选诗与组装都在同目录 poem-build.mjs。strict 模式：GLM 注释失败即拒收当日
 * （预生成要存一个月，宁缺勿滥），重跑本脚本即补。
 *
 * 用法（本仓库根目录，缺省当月）：
 *   node tools/batch-poems.mjs [YYYY-MM] [--from YYYY-MM-DD] [--force]
 *     --from   只生成该日起（跳过已过期的日子，如 11 月 3 日才跑就从 11-04 起）
 *     --force  已有日期也重做（默认跳过，幂等可续跑）
 * 语料（poems/）有增删的话，先重跑 poem-index.mjs 并提交，否则抽的作者池
 * 会和已生成的月份不一致。
 *
 * 生成完 commit + push，主仓 CI 才能拉到。
 */
'use strict';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZh, buildZhModern, buildEn, buildDe, periodOf } from './poem-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const opt = name => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };

    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const month = args.find(a => /^\d{4}-(0[1-9]|1[0-2])$/.test(a)) || now.slice(0, 7);
    const from = opt('--from') || `${month}-01`; // YYYY-MM-DD 字符串序比较即可

    if (!process.env.ZHIPU_API_KEY) throw new Error('未设置 ZHIPU_API_KEY（注释必需），拒跑');

    const mm = month.slice(5, 7);
    const days = new Date(+month.slice(0, 4), +mm, 0).getDate();
    const outDir = path.join(ROOT, 'daily', mm);
    await mkdir(outDir, { recursive: true });

    console.log(`预生成 ${month} → ${outDir}\n中文双页逐日、英德六天一组调 GLM，整月约 15–25 分钟，可随时中断重跑续传…`);
    const t0 = Date.now();
    let done = 0, skipped = 0;
    const failed = [];
    let enCached = null, deCached = null, cachedStart = ''; // 英德组内复用：缓存组首日构建结果
    for (let d = 1; d <= days; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        if (date < from) continue;
        const file = path.join(outDir, `${date}.json`);
        if (!force) {
            try { JSON.parse(await readFile(file, 'utf8')); skipped++; continue; } catch { /* 尚未生成 */ }
        }
        try {
            const opts = { gen: '预生成', strict: true };
            const [zh, zhModern] = await Promise.all([
                buildZh(date, opts), buildZhModern(date, opts),
            ]);
            const per = periodOf(date);
            let enNew = false; // 本日是否新构建英德（组首或 --from 截进组内时）
            if (cachedStart !== per.start) {
                cachedStart = per.start;
                enNew = true;
                [enCached, deCached] = await Promise.all([buildEn(date, opts), buildDe(date, opts)]);
            }
            const bake = r => ({ file: r.file, log: r.log, md: r.md.join('\n') + '\n' });
            await writeFile(file, JSON.stringify({
                date, generatedAt: new Date().toISOString(),
                zh: bake(zh), zhModern: bake(zhModern), en: bake(enCached), de: bake(deCached),
            }, null, 2) + '\n', 'utf8');
            done++;
            console.log(`  ${date} ✓ 第${done}天  ${zh.log} | ${zhModern.log}`
                + (enNew ? ` | ${enCached.log} | ${deCached.log}` : ''));
        } catch (err) {
            failed.push(date);
            console.warn(`  ${date} ✗ ${err.message}（重跑即补）`);
        }
    }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`\n完成：新增 ${done} 天 · 跳过 ${skipped} 天 · 失败 ${failed.length} 天`
        + (failed.length ? `（${failed.join('、')}）` : '') + ` · 用时 ${mins} 分钟`);
    console.log('下一步：本仓库 commit + push，主仓 CI 才能拉到');
}

main().catch(err => {
    console.error('批量预生成失败：', err.message);
    process.exit(1);
});
