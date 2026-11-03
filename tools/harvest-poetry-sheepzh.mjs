#!/usr/bin/env node
/**
 * ── 收割：GitHub sheepzh/poetry → blog-comments/poems/zh/modern/{流派}/{作者}/ ──
 *
 * 源是社区维护的汉语现代诗语料库（github.com/sheepzh/poetry，MIT；汇编开源
 * ≠ 作品公版，仓库自声明"著作权归原作者"）。它同时收录了大量在版权作者
 * （北岛、海子、艾青……），因此本脚本**只收白名单**：逝世满 50 年（中国
 * 著作权保护期）的作者。这条红线是语料库的立库原则，勿改成全量拉取；
 * 想加人先核卒年，满了再加进 POETS 表。
 *
 * 白名单同时含最早手工录入的六位（徐志摩/闻一多/戴望舒/李叔同/刘半农/
 * 林徽因）：对他们做**合并**而非覆盖——现有 poems.json 条目全保留，源库
 * 按标题去重后只追加缺的；author.json 本就存在（wx），简介不会被动。
 * 不在源库、以后可手补：蒋光慈、石评梅、蒲风、柯仲平。临期解禁（源库都有
 * 货，届时加进白名单重跑即可）：李金发→象征派、郭小川→十七年 2027-01；
 * 何其芳→现代派 2028-01。穆旦/郭沫若眼下在本地私藏 D:\现代诗，2028-01 /
 * 2029-01 公版后升入本库（九叶派 / 创造社浪漫）。
 *
 * 实现：下整仓 tarball 一次（codeload），内存里解 gzip + 解 tar，只取
 * 白名单作者目录下的 .pt 文件；无逐文件请求、无第三方依赖。
 * .pt 格式：`title:`/`date:` 头 + 空行 + 正文（空行分节）。
 *
 * 幂等可重跑：poems.json 覆盖写，author.json 只在缺失时写（wx，手补简介
 * 不会被冲）。收割完在仓库根目录跑 `node tools/poem-index.mjs` 重建索引。
 *
 * 用法（blog-comments 仓库根目录；本地需代理）：
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node tools/harvest-poetry-sheepzh.mjs
 */
'use strict';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const TARBALL = 'https://codeload.github.com/sheepzh/poetry/tar.gz/refs/heads/master';

/* 白名单：源库目录名 → [流派, 生卒, 简介]。全部逝世满 50 年（2026 年核）。
 * 流派目录 2026-11-03 起（文学史通行分期，主干据《中国现代文学三十年》+
 * 洪子诚《中国当代文学史》）；李叔同的学堂乐歌是白话诗先声，归白话初创。 */
const POETS = {
    '徐志摩_xuzhimo': ['新月派', '1897–1931', '新月派代表，《再别康桥》传诵至今，追求诗歌的音韵与意象之美。'],
    '闻一多_wenyiduo': ['新月派', '1899–1946', '新月派诗人、学者，提出音乐美/绘画美/建筑美"三美"，著《红烛》《死水》。'],
    '戴望舒_daiwangshu': ['现代派', '1905–1950', '现代派象征主义诗人，以《雨巷》得名"雨巷诗人"。'],
    '李叔同_lishutong': ['白话初创', '1880–1942', '弘一法师。近代艺术全才，《送别》词作者，学堂乐歌为白话诗先声。'],
    '刘半农_liubannong': ['白话初创', '1891–1934', '新文化运动干将，"她"字的首创者之一。'],
    '林徽因_linhuiyin': ['新月派', '1904–1955', '建筑学家、诗人，《你是人间的四月天》广为传诵。'],
    '鲁迅_luxun': ['白话初创', '1881–1936', '以《野草》开中国散文诗之境，兼作旧体诗；新诗虽少，皆白话诗初创样本。'],
    '胡适_hushi': ['白话初创', '1891–1962', '新文化运动旗手，《尝试集》为中国第一部白话新诗集。'],
    '刘大白_liudabai': ['白话初创', '1880–1932', '早期白话诗人，《卖布谣》《邮吻》以民歌调写民间疾苦。'],
    '沈尹默_shenyinmo': ['白话初创', '1883–1971', '书法家、诗人，新诗初创期名家，《月夜》四行而名重一时。'],
    '康白情_kangbaiqing': ['白话初创', '1896–1958', '少年中国学会成员，《草儿》以白话写景开一代新风。'],
    '朱湘_zhuxiang': ['新月派', '1904–1933', '新月派诗人，讲格律音韵，《采莲曲》传诵；投江早逝，人称"中国的济慈"。'],
    '陈梦家_chenmengjia': ['新月派', '1911–1966', '新月派后期代表，编《新月诗选》，后成古文字学家。'],
    '邵洵美_shaoxunmei': ['新月派', '1906–1968', '唯美派诗人兼出版家，《花一般的罪恶》作者。'],
    '殷夫_yinfu': ['左翼', '1910–1931', '左联五烈士之一，红色鼓动诗代表，鲁迅称其诗"属于别一世界"。'],
    '李广田_liguangtian': ['现代派', '1906–1968', '汉园三诗人之一（与卞之琳、何其芳），诗风朴厚沉静。'],
    '穆木天_mumutian': ['象征派', '1900–1971', '创造社成员，象征主义诗集《旅心》作者，后倡诗歌大众化。'],
    '王独清_wangduqing': ['象征派', '1898–1940', '创造社诗人，徘徊于象征与浪漫之间，《圣母像前》作者。'],
    '废名_feiming': ['现代派', '1901–1967', '京派作家，诗风晦涩跳跃如其小说，《掐花》《镜》等短章自成一格。'],
    '朱自清_zhuziqing': ['白话初创', '1898–1948', '散文名家，新诗有《毁灭》《踪迹》，文学研究会成员。'],
    '周作人_zhouzuoren': ['白话初创', '1885–1967', '散文大家，新诗初创期《小河》被誉为"新诗中的第一首杰作"。'],
    '方玮德_fangweide': ['新月派', '1908–1935', '新月派后期诗人，深受闻一多赏识，英年早逝。'],
    '饶孟侃_raomengkan': ['新月派', '1902–1967', '新月派诗人，讲格律音韵，与闻一多切磋诗艺。'],
    '闻捷_wenjie': ['十七年', '1923–1971', '当代叙事抒情诗代表，《天山牧歌》写边疆爱情。'],
};

/* ── tar 解包：512 字节头逐块走，typeflag 'x'（pax）里的 path= 覆盖下一个条目 ── */
function* tarEntries(buf) {
    let off = 0, paxPath = null;
    while (off + 512 <= buf.length) {
        const h = buf.subarray(off, off + 512);
        if (h.every(b => b === 0)) break; // 结尾两个全零块
        const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/, '');
        const size = parseInt(str(124, 136).trim(), 8) || 0;
        const type = h.toString('ascii', 156, 157);
        const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
        const data = buf.subarray(off + 512, off + 512 + size);
        if (type === 'x') { // pax 扩展头："长度 key=value\n" 记录，取 path
            const m = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]+)/);
            paxPath = m ? m[1] : null;
        } else {
            yield { name: paxPath || name, type, data };
            paxPath = null;
        }
        off += 512 + Math.ceil(size / 512) * 512;
    }
}

/* .pt → {title, year, stanzas}；文件名带"节选"标记的在标题上补注 */
function parsePt(text, fileName) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let title = '', year = null, i = 0;
    for (; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('title:')) title = l.slice(6).trim().replace(/^[“”"'『「]+|[“”"'』」]+$/g, '').trim(); // 源库有的标题整体裹引号，去掉
        else if (l.startsWith('date:')) {
            const m = l.slice(5).trim().match(/^(19|20)\d{2}/);
            if (m) year = m[0];
        } else break; // 空行或正文起点：头结束
    }
    const stanzas = lines.slice(i).join('\n')
        .split(/\n[ \t]*\n+/)
        .map(s => s.split('\n').map(l => l.trim()).filter(Boolean).join('\n'))
        .filter(Boolean);
    if (fileName.includes('节选') && !title.includes('节选')) title += '（节选）';
    return { title, year, stanzas };
}

async function main() {
    console.log(`下载源库 tarball（~40MB）…`);
    const res = await fetch(TARBALL, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`codeload ${res.status}`);
    const buf = gunzipSync(Buffer.from(await res.arrayBuffer()));
    console.log(`解包完成（${(buf.length / 1048576).toFixed(0)}MB），筛白名单 ${Object.keys(POETS).length} 位作者…`);

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'poems', 'zh', 'modern');
    const byAuthor = Object.fromEntries(Object.keys(POETS).map(k => [k, []]));
    const PREFIX = 'poetry-master/data/';
    for (const e of tarEntries(buf)) {
        if (e.type !== '0' || !e.name.endsWith('.pt')) continue;
        const rel = e.name.slice(e.name.startsWith(PREFIX) ? PREFIX.length : 0);
        const slash = rel.indexOf('/');
        if (slash < 0) continue;
        const dir = rel.slice(0, slash);
        if (!POETS[dir]) continue; // 白名单外一概不收
        const p = parsePt(e.data.toString('utf8'), e.name);
        if (p.title && p.stanzas.length && p.stanzas.join('\n').length >= 8) byAuthor[dir].push(p);
    }

    let total = 0, added = 0;
    for (const [dir, poems] of Object.entries(byAuthor)) {
        const author = dir.slice(0, dir.indexOf('_'));
        if (!poems.length) { console.warn(`  ${author}：源库没有可用篇目，跳过`); continue; }
        const out = path.join(root, POETS[dir][0], author); // {流派}/{作者}
        await mkdir(out, { recursive: true });

        // 已有 poems.json（手工录入或上次收割）：按标题去重合并，老条目原样保留
        const file = path.join(out, 'poems.json');
        let kept = [];
        try { kept = JSON.parse(await readFile(file, 'utf8')).poems || []; } catch { /* 新作者 */ }
        const seen = new Set(kept.map(p => p.title));
        const fresh = poems.filter(p => !seen.has(p.title));
        const merged = [...kept, ...fresh]
            .sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : 0); // 字节序稳定，重跑结果一致

        await writeFile(file, JSON.stringify({ author, poems: merged }, null, 2) + '\n', 'utf8');
        try {
            const [, years, intro] = POETS[dir];
            await writeFile(path.join(out, 'author.json'),
                JSON.stringify({ author, years, intro }, null, 2) + '\n', { flag: 'wx' });
        } catch { /* 已有（含手补简介）不覆盖 */ }
        total += merged.length;
        added += fresh.length;
        console.log(`  ${author}：${merged.length} 首${kept.length ? `（原有 ${kept.length} + 新增 ${fresh.length}）` : ''}`);
    }
    console.log(`合计 ${total} 首（本次新增 ${added}）→ poems/zh/modern/`);
    console.log('下一步：node tools/poem-index.mjs 重建索引，一起提交。');
}

main().catch(err => {
    console.error('收割 sheepzh/poetry 失败：', err.message);
    process.exit(1);
});
