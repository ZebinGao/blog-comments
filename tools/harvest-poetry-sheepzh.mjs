#!/usr/bin/env node
/**
 * ── 收割：GitHub sheepzh/poetry → blog-comments/poems/zh/modern/{流派}/{作者}/ ──
 *
 * 源是社区维护的汉语现代诗语料库 github.com/sheepzh/poetry（MIT）。
 * 实现：整仓 tarball 一次拉回（codeload，~40MB），内存解 gzip + 解 tar，
 * 按 POETS 名单前缀匹配（源库目录名是 名字_拼音），只取 .pt 文件；
 * 无逐文件请求、无第三方依赖。.pt 格式：`title:`/`date:` 头 + 空行 +
 * 正文（空行分节）。
 *
 * 名单全量 49 位，流派层按文学史通行分期（《中国现代文学三十年》+ 洪子诚
 * 《中国当代文学史》）。除公版作者外也收在版权作者（简介里标注进入公版
 * 的时间），随语料全量入库、全量进索引；在版权作品仅供个人学习、研究、
 * 欣赏（著作权法第 24 条合理使用），请勿作商业用途。
 *
 * 幂等可重跑：poems.json 与已有条目按标题去重合并（老条目原样保留），
 * author.json 只在缺失时写（wx，手补简介不会被冲）。收割完在仓库根目录
 * 跑 `node tools/poem-index.mjs` 重建索引。
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

/* 作者名 → [流派, 生卒, 一句话定位]。目录名在源库里是 名字_拼音，按前缀匹配。
 * 流派层与 poems/zh/modern 的目录划分一一对应；标注升公开日期的在版权
 * 作者，届时无需操作（已入库已索引），日期仅作标注。 */
const POETS = {
    // 白话初创（1917–1925）
    '胡适': ['白话初创', '1891–1962', '新文化运动旗手，《尝试集》为中国第一部白话新诗集。'],
    '鲁迅': ['白话初创', '1881–1936', '以《野草》开中国散文诗之境，兼作旧体诗；新诗虽少，皆白话诗初创样本。'],
    '李叔同': ['白话初创', '1880–1942', '弘一法师。近代艺术全才，《送别》词作者，学堂乐歌为白话诗先声。'],
    '刘半农': ['白话初创', '1891–1934', '新文化运动干将，"她"字的首创者之一。'],
    '刘大白': ['白话初创', '1880–1932', '早期白话诗人，《卖布谣》《邮吻》以民歌调写民间疾苦。'],
    '沈尹默': ['白话初创', '1883–1971', '书法家、诗人，新诗初创期名家，《月夜》四行而名重一时。'],
    '周作人': ['白话初创', '1885–1967', '散文大家，新诗初创期《小河》被誉为"新诗中的第一首杰作"。'],
    '康白情': ['白话初创', '1896–1958', '少年中国学会成员，《草儿》以白话写景开一代新风。'],
    '朱自清': ['白话初创', '1898–1948', '散文名家，新诗有《毁灭》《踪迹》，文学研究会成员。'],
    // 创造社浪漫（1921–）
    '郭沫若': ['创造社浪漫', '1892–1978', '《女神》开一代诗风。2029-01 进公版，届时可升入公开语料库。'],
    // 新月派（1926–）
    '闻一多': ['新月派', '1899–1946', '新月派诗人、学者，提出音乐美/绘画美/建筑美"三美"，著《红烛》《死水》。'],
    '徐志摩': ['新月派', '1897–1931', '新月派代表，《再别康桥》传诵至今，追求诗歌的音韵与意象之美。'],
    '林徽因': ['新月派', '1904–1955', '建筑学家、诗人，《你是人间的四月天》广为传诵。'],
    '朱湘': ['新月派', '1904–1933', '新月派诗人，讲格律音韵，《采莲曲》传诵；投江早逝，人称"中国的济慈"。'],
    '陈梦家': ['新月派', '1911–1966', '新月派后期代表，编《新月诗选》，后成古文字学家。'],
    '邵洵美': ['新月派', '1906–1968', '唯美派诗人兼出版家，《花一般的罪恶》作者。'],
    '方玮德': ['新月派', '1908–1935', '新月派后期诗人，深受闻一多赏识，英年早逝。'],
    '饶孟侃': ['新月派', '1902–1967', '新月派诗人，讲格律音韵，与闻一多切磋诗艺。'],
    // 象征派（1925–）
    '李金发': ['象征派', '1900–1976', '象征派开山，《微雨》《食客与凶年》引法国象征主义入新诗。2027-01 升公开。'],
    '穆木天': ['象征派', '1900–1971', '创造社成员，象征主义诗集《旅心》作者，后倡诗歌大众化。'],
    '王独清': ['象征派', '1898–1940', '创造社诗人，徘徊于象征与浪漫之间，《圣母像前》作者。'],
    // 现代派（1932–）
    '戴望舒': ['现代派', '1905–1950', '现代派象征主义诗人，以《雨巷》得名"雨巷诗人"。'],
    '卞之琳': ['现代派', '1910–2000', '《断章》四行传世，"化古化欧"的智性诗风；汉园三诗人之一。'],
    '冯至': ['现代派', '1905–1993', '鲁迅称"中国最杰出的抒情诗人"，《十四行集》借里尔克沉思存在。'],
    '何其芳': ['现代派', '1912–1977', '汉园三诗人之一，《预言》缠绵唯美。2028-01 升公开。'],
    '废名': ['现代派', '1901–1967', '京派作家，诗风晦涩跳跃如其小说，《掐花》《镜》等短章自成一格。'],
    '李广田': ['现代派', '1906–1968', '汉园三诗人之一（与卞之琳、何其芳），诗风朴厚沉静。'],
    // 左翼（1932–）
    '艾青': ['左翼', '1910–1996', '《大堰河——我的保姆》《雪落在中国的土地上》，新诗史写实高峰。'],
    '臧克家': ['左翼', '1905–2004', '《老马》《烙印》写农民的苦难与坚韧。'],
    '田间': ['左翼', '1916–1985', '鼓点式街头诗，《假使我们不去打仗》，闻一多称"时代的鼓手"。'],
    '殷夫': ['左翼', '1910–1931', '左联五烈士之一，红色鼓动诗代表，鲁迅称其诗"属于别一世界"。'],
    // 九叶派（1940s）
    '穆旦': ['九叶派', '1918–1977', '九叶派诗人、翻译家查良铮，《赞美》《诗八首》。2028-01 升公开。'],
    '郑敏': ['九叶派', '1920–2022', '九叶派最后一位，《金黄的稻束》的沉思意象。'],
    // 十七年（1949–1966）
    '闻捷': ['十七年', '1923–1971', '当代叙事抒情诗代表，《天山牧歌》写边疆爱情。'],
    '郭小川': ['十七年', '1919–1976', '《望星空》《甘蔗林——青纱帐》，政治抒情诗代表。2027-01 升公开。'],
    // 台湾现代诗（1950s–）
    '余光中': ['台湾现代诗', '1928–2017', '《乡愁》四段传诵，台湾现代诗中坚。'],
    '痖弦': ['台湾现代诗', '1932–2024', '《红玉米》《深渊》，创世纪诗社核心。'],
    // 朦胧诗（1970s末–）
    '北岛': ['朦胧诗', '1949–', '朦胧诗旗手，《回答》"卑鄙是卑鄙者的通行证"。'],
    '顾城': ['朦胧诗', '1956–1993', '朦胧诗代表，"黑夜给了我黑色的眼睛"，童话诗人。'],
    '舒婷': ['朦胧诗', '1952–', '《致橡树》《祖国啊，我亲爱的祖国》，朦胧诗的女性声音。'],
    '食指': ['朦胧诗', '1948–', '《相信未来》《这是四点零八分的北京》，朦胧诗先声。'],
    // 神性写作（1980s–）
    '海子': ['神性写作', '1964–1989', '"面朝大海，春暖花开"，《太阳七部书》的史诗冲动。'],
    '昌耀': ['神性写作', '1936–2000', '青藏高原的荒原型写作，《慈航》圣化自然。'],
    '西川': ['神性写作', '1963–', '从神性书写走向知识综合，与海子、骆一禾并称北大三诗人。'],
    // 民间写作（1990s–）
    '于坚': ['民间写作', '1954–', '"他们"诗群核心，《0档案》口语写作代表，盘峰论争民间方旗手。'],
    // 中间代（1960s 生，1990s 成名）
    '安琪': ['中间代', '1969–', '本名黄江嫔，"中间代"命名者之一，主编《中间代诗全集》，以长诗见长。'],
    '哑石': ['中间代', '1966–', '北大数学系出身，四川九十年代先锋一线，口语而玄学的密度写作。'],
    '陈先发': ['中间代', '1967–', '倡"本土性"写作，自桐城文章与禅宗公案翻汉语旧家底，《前世》《九章》。'],
    // 小诗体（1920s，冰心一脉单列）
    '冰心': ['小诗体', '1900–1999', '《繁星》《春水》小诗体代表。2050 年进公版。'],
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
    console.log(`解包完成（${(buf.length / 1048576).toFixed(0)}MB），筛名单 ${Object.keys(POETS).length} 位作者…`);

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'poems', 'zh', 'modern');
    const byAuthor = Object.fromEntries(Object.keys(POETS).map(k => [k, []]));
    const PREFIX = 'poetry-master/data/';
    for (const e of tarEntries(buf)) {
        if (e.type !== '0' || !e.name.endsWith('.pt')) continue;
        const rel = e.name.slice(e.name.startsWith(PREFIX) ? PREFIX.length : 0);
        const slash = rel.indexOf('/');
        if (slash < 0) continue;
        const dir = rel.slice(0, slash);
        const hit = Object.keys(POETS).find(n => dir.startsWith(n + '_')); // 名字_拼音 前缀匹配
        if (!hit) continue; // 名单外一概不收
        const p = parsePt(e.data.toString('utf8'), e.name);
        if (p.title && p.stanzas.length && p.stanzas.join('\n').length >= 8) byAuthor[hit].push(p);
    }

    let total = 0, added = 0;
    for (const [author, poems] of Object.entries(byAuthor)) {
        if (!poems.length) { console.warn(`  ${author}：源库没有可用篇目，跳过`); continue; }
        const out = path.join(root, POETS[author][0], author); // {流派}/{作者}
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
            const [, years, intro] = POETS[author];
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
