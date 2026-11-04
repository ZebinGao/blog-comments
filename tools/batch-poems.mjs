#!/usr/bin/env node
/**
 * ── 批量预生成整月四页 → 本仓库 daily/{年}/{月}/{日期}.json ──────────
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
 *   node tools/batch-poems.mjs [YYYY-MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--force] [--plan]
 *     --plan   只打印整月选诗与正文（不调 GLM），并写一份极简选诗清单
 *              daily/{月}/selection.md（只记作者与作品，中文逐日、英德按期）。
 *              完整正文打印在终端，交给 Claude 逐首写注释进
 *              daily/{年}/{月}/notes.json（键 `${选诗日期}:${kind}`，条目须带 title
 *              诗名，语料变动后不符的手注自动作废），再跑本脚本：有手注的键
 *              直接用，缺的才走智谱 API
 *     --from   只生成该日起（跳过已过期的日子，如 11 月 3 日才跑就从 11-04 起）
 *     --to     只生成到该日止——七天一段滚动生成，跑完一段看一眼再续下一段
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
import { buildZh, buildZhModern, buildEn, buildDe, periodOf, planDay } from './poem-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const opt = name => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };

    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const month = args.find(a => /^\d{4}-(0[1-9]|1[0-2])$/.test(a)) || now.slice(0, 7);
    const from = opt('--from') || `${month}-01`; // YYYY-MM-DD 字符串序比较即可
    const to = opt('--to') || `${month}-31`;

    const mm = month.slice(5, 7);
    const days = new Date(+month.slice(0, 4), +mm, 0).getDate();

    if (args.includes('--plan')) { // 只看选诗，不需要密钥
        const rows = [], periods = []; // rows → 中文逐日；periods → 英德按期（组首入列）
        for (let d = 1; d <= days; d++) {
            const date = `${month}-${String(d).padStart(2, '0')}`;
            if (date < from || date > to) continue;
            const r = await planDay(date);
            const show = (kind, selDate, p) => console.log(
                `\n[${kind} @ ${selDate}] ${p.meta}\n《${p.title}》\n${p.stanzas.join('\n\n')}`);
            console.log(`\n== ${date} ==`);
            show('zh', date, r.zh);
            show('modern', date, r.zhModern);
            show('en', periodOf(date).start, r.en);
            show('de', periodOf(date).start, r.de);
            // 极简清单：meta 是「朝代·作者·体裁」或「作者·生卒·年份」，取作者那段
            const author = (kind, meta) => {
                const parts = meta.split(' · ');
                return kind === 'zh' ? (parts[1] || parts[0]) : parts[0];
            };
            rows.push(`| ${date.slice(5)} | ${author('zh', r.zh.meta)}《${r.zh.title}》`
                + ` | ${author('modern', r.zhModern.meta)}《${r.zhModern.title}》 |`);
            const { start, label } = periodOf(date);
            if (!periods.some(p => p.start === start)) periods.push({
                start, label,
                en: `${author('en', r.en.meta)} "${r.en.title}"`,
                de: `${author('de', r.de.meta)} „${r.de.title}“`,
            });
        }
        const selFile = path.join(ROOT, 'daily', month.slice(0, 4), mm, 'selection.md');
        await mkdir(path.dirname(selFile), { recursive: true });
        await writeFile(selFile, `# ${month} 选诗清单\n\n## 中文（逐日）\n\n`
            + `| 日期 | 古典 | 现代 |\n|---|---|---|\n${rows.join('\n')}\n\n`
            + `## 英文 / 德文（六天一期）\n\n| 期间 | 英文 | 德文 |\n|---|---|---|\n`
            + periods.map(p => `| ${p.label} | ${p.en} | ${p.de} |`).join('\n') + '\n', 'utf8');
        console.log(`\n选诗清单 → ${selFile}`);
        return;
    }

    if (!process.env.ZHIPU_API_KEY) throw new Error('未设置 ZHIPU_API_KEY（注释必需），拒跑');

    const outDir = path.join(ROOT, 'daily', month.slice(0, 4), mm); // 2026-11-04 起按年分目录，跨年不混月
    await mkdir(outDir, { recursive: true });

    console.log(`预生成 ${month} → ${outDir}\n中文双页逐日、英德六天一组调 GLM，整月约 15–25 分钟，可随时中断重跑续传…`);
    const t0 = Date.now();
    let done = 0, skipped = 0;
    const failed = [];
    let enCached = null, deCached = null, cachedStart = ''; // 英德组内复用：缓存组首日构建结果
    for (let d = 1; d <= days; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        if (date < from || date > to) continue;
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
