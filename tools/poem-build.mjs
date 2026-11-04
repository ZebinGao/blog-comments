#!/usr/bin/env node
/**
 * ── 模块：选诗 + 智谱 GLM 注释 + 四页 Markdown ──────────────
 *
 * 三语四页（layout: poem-daily）：
 *   中文·古典 / 中文·现代 —— 两个子页各自日更；
 *   英文 / 德文 —— 六天一更：按月内 1–6、7–12、13–18、19–24、25–月底 分组，
 *            组内同一首（欧洲作者均逝世满 70 年，布莱希特 2027 年满期后可补）。
 *
 * 本文件是纯模块（不直接跑），被同目录 batch-poems.mjs 每月批量调用，成品
 * JSON 存进本仓库 daily/{月}/{日期}.json；主仓 CI 的 fetch-poem.mjs 只拉成品
 * 落盘，不碰语料与 GLM。语料就在本仓库 poems/，全部本地读。
 *
 * 选法（2026-10-29 起）：按选诗日期 FNV-1a 哈希，先在 index.json 的作者清单里
 * 均匀抽一位、再二级哈希在其名下抽篇（白居易千余首不会挤掉王昌龄二十一首）；
 * 中文两页选诗日期就是当天，英德用所在六天组的组首日（组内同一首）；同一天
 * 跑几遍四页各是同一首，语料增删导致 index.json 变化才会换诗。
 *
 * 注释 + 翻译：优先读 daily/{月}/notes.json 的手工注释（Claude 每月批量写作，
 * 键 `${选诗日期}:${kind}`，英德用组首日），缺的键才调智谱 GLM（需
 * ZHIPU_API_KEY），每语种独立 prompt——古典出难词拼音+释义、英文出音标+释义、
 * 德语出词性+中文释义、现代诗只出赏析不要白话翻译。strict 模式（批量用）注释
 * 失败即抛错拒收当日，重跑 batch 即补（或补写 notes.json 对应键）。
 */
'use strict';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZHIPU_API = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const POEMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'poems');
/* 2026-11-04 应用户要求默认开思考出注释（试质量对比）；思考全烧在 reasoning 上，
 * 单次更慢，超时相应放宽到 5 分钟。要回快车道：ZHIPU_THINKING=off。 */
const THINKING = process.env.ZHIPU_THINKING !== 'off';
const API_TIMEOUT = THINKING ? 300000 : 120000;

/* 英德六天一更的分组：按月内日期 1–6、7–12、13–18、19–24、25–月底，组内同一首。
 * 返回组首日（做选诗哈希的"选诗日期"）与展示标签。 */
export function periodOf(date) {
    const [y, m, d] = date.split('-').map(Number);
    const start = (Math.ceil(d / 6) - 1) * 6 + 1;
    const end = Math.min(start + 5, new Date(y, m, 0).getDate()); // 末组掐到月底，下月 1 号开新组
    const p = n => `${String(m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    return { start: `${y}-${String(m).padStart(2, '0')}-${String(start).padStart(2, '0')}`, label: `${p(start)}–${p(end)}` };
}

/* FNV-1a：够用的确定性哈希，同一天同一份数据必得同一首 */
function hash(str) {
    let h = 0x811c9dc5;
    for (const b of Buffer.from(str, 'utf8')) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/* 只服务智谱 API（语料全在本地）：3 次退避重试。正常 1–2 分钟内返回，超时
 * 2 分钟即掐（2026-11-03 批量连环超时根因是 token 额度耗尽挂起，非模型慢）。 */
async function fetchText(url, init = {}, timeoutMs = 120000) {
    let lastErr;
    for (let i = 1; i <= 3; i++) {
        try {
            const res = await fetch(url, {
                ...init,
                headers: {
                    'User-Agent': 'zebin-blog-poem-builder', 'Accept-Language': 'zh-cn',
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(init.headers || {}),
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
                const err = new Error(`${new URL(url).host} ${res.status} ${res.statusText}`);
                err.status = res.status;
                throw err;
            }
            return await res.text();
        } catch (err) {
            lastErr = err;
            // 4xx（除 429 限流）是"密钥无效"之类的确定性失败，重试无意义
            if (err.status && err.status < 500 && err.status !== 429) throw err;
            console.warn(`  第 ${i} 次尝试失败：${err.cause ? err.cause.code || err.cause.message : err.message}`);
            if (i < 3) await new Promise(r => setTimeout(r, i * 2000));
        }
    }
    throw lastErr;
}
const getJson = async (url, init, timeoutMs) => JSON.parse(await fetchText(url, init, timeoutMs));

/* 语料 JSON 本地加载。index.json 全程只读一次，缓存给四页共用 */
let _index;
const loadJson = async rel => JSON.parse(await readFile(path.join(POEMS_DIR, rel), 'utf8'));
const getIndex = () => (_index ||= loadJson('index.json'));

/* Markdown 安全：尖括号换全角，防止释义里的 <xx> 被当成 HTML 标签吞掉 */
const mdSafe = s => String(s || '').replace(/</g, '＜').replace(/>/g, '＞').trim();
const trim = s => String(s || '').trim();

/* 引用块组装：诗按节排版——节内行尾加两个空格硬换行，节间插空引用行分节。
 * stanzas: ['行1\n行2', …]（语料收割时就按这个结构存的） */
function quoteBlock(stanzas) {
    const out = [];
    stanzas.forEach((stanza, si) => {
        const lines = stanza.split('\n').map(l => l.trim()).filter(Boolean);
        lines.forEach((l, i) => out.push('> ' + mdSafe(l) + (i < lines.length - 1 ? '  ' : '')));
        if (si < stanzas.length - 1) out.push('>');
    });
    return out;
}

/* ── 智谱 GLM 注释：每语种一套 prompt。返回 {notes, translation, brief, model}
 *    或 null（失败/未配 key，降级为无注）。 */
const SYSTEMS = {
    zh: '你是古典诗词注家，输出只有 JSON 本身。',
    modern: '你是新诗注家，输出只有 JSON 本身。',
    en: '你是英语诗歌注家，面向中文读者讲解，输出只有 JSON 本身。',
    de: '你是德语诗歌注家，面向中文读者讲解，输出只有 JSON 本身。',
};
const ASKS = {
    zh: (meta, title, poemText) =>
        `${meta}《${title}》\n${poemText}\n`
        + '请为这首诗词输出严格 JSON（不要 markdown 代码块）：'
        + '{"notes":[["难词","pīnyīn：释义"],…],"translation":"整首白话翻译，多行用\\n分隔",'
        + '"brief":"2-3句简析：写作背景、格律或章法、最妙处"}。'
        + 'notes 按诗中出现顺序，5-10 条，只收对今人偏难的字词（给拼音）和典故；不要注释常见词。',
    modern: (meta, title, poemText) =>
        `新诗《${title}》（${meta}）\n${poemText}\n`
        + '请为这首新诗输出严格 JSON（不要 markdown 代码块）：'
        + '{"notes":[["偏难词或意象","一句话释义"],…],"brief":"3-4句赏析：写作背景（若可考）、'
        + '分节与意象的经营、音乐性、最妙处"}。'
        + 'notes 只收对一般读者偏难的词和典故，2-6 条，没有就给空数组；不要白话翻译（新诗不需要）。',
    en: (meta, title, poemText) =>
        `${meta} — "${title}"\n${poemText}\n`
        + '请为这首英文诗向中文读者输出严格 JSON（不要 markdown 代码块）：'
        + '{"notes":[["word","音标 · 中文释义"],…],"translation":"逐行对应的中文译文，行用\\n分隔、保留分节",'
        + '"brief":"2-3句简析：作者与背景、格律或韵式（如 abab）、最妙处"}。'
        + 'notes 按诗中出现顺序 5-10 条，只收对非英语读者偏难的词和文化专名；英文词原样，释义用中文。',
    de: (meta, title, poemText) =>
        `${meta} — „${title}“\n${poemText}\n`
        + '请为这首德语诗向中文读者输出严格 JSON（不要 markdown 代码块）：'
        + '{"notes":[["Wort","词性 · 中文释义（名词附冠词与复数）"],…],"translation":"逐行对应的中文译文，行用\\n分隔、保留分节",'
        + '"brief":"2-3句简析：作者与背景、格律或体裁（如 Volksliedstrophe）、最妙处"}。'
        + 'notes 按诗中出现顺序 5-10 条，只收对德语学习者偏难的词（保留文中变位形式）；德语词原样，释义用中文。',
};

/* 手工注释（Claude 每月批量写作）优先于 GLM：daily/{月}/notes.json，键
 * `${选诗日期}:${kind}`（英德用组首日），值 {title, notes, translation?, brief}。
 * title 记注释对象诗名——语料变动导致重选时诗名对不上，手注作废走 GLM，
 * 防张冠李戴。有手注不调 API——限流/额度/超时全免；缺键回落 GLM。 */
let _notes;
async function getNotes(selDate) {
    if (_notes === undefined) {
        const file = path.resolve(POEMS_DIR, '..', 'daily', selDate.slice(5, 7), 'notes.json');
        _notes = await readFile(file, 'utf8').then(t => JSON.parse(t)).catch(() => ({}));
    }
    return _notes;
}

async function annotate(kind, selDate, meta, title, poemText) {
    const hand = (await getNotes(selDate))[`${selDate}:${kind}`];
    if (hand && Array.isArray(hand.notes)) {
        if (!hand.title || hand.title === title) return { model: 'Claude', ...hand };
        console.warn(`  [${kind}] ${selDate} 手注是《${hand.title}》，今天选到《${title}》，对不上——改走 GLM`);
    }
    const key = process.env.ZHIPU_API_KEY;
    if (!key) {
        console.warn(`  [${kind}] 未设置 ZHIPU_API_KEY，跳过注释翻译，页面只出诗本身`);
        return null;
    }
    const apiModel = process.env.ZHIPU_MODEL || 'glm-5.3';
    const model = `智谱 ${apiModel}`; // 页脚署名；请求体须用 apiModel，混进"智谱"前缀会被 400 秒拒
    const ask = ASKS[kind](meta, title, poemText);
    // 3 次尝试：关思考后偶发 JSON 不守契约（缺 translation 之类），两次连撞的概率不低
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await getJson(ZHIPU_API, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: apiModel,
                    messages: [
                        { role: 'system', content: SYSTEMS[kind] },
                        { role: 'user', content: ask },
                    ],
                    temperature: 0.3,
                    thinking: { type: THINKING ? 'enabled' : 'disabled' },
                    response_format: { type: 'json_object' },
                }),
            }, API_TIMEOUT);
            let content = resp.choices?.[0]?.message?.content || '';
            content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); // 防模型不听话裹代码块
            const out = JSON.parse(content);
            const needTranslation = kind !== 'modern';
            const okNotes = Array.isArray(out.notes);
            const okTranslation = !needTranslation || typeof out.translation === 'string';
            if (okNotes && okTranslation) return { ...out, model };
            throw new Error(`JSON 结构不对（实际字段：${Object.keys(out).join(',')}）`);
        } catch (err) {
            console.warn(`  [${kind}] 注释第 ${attempt} 次失败：${err.message}`);
        }
    }
    return null; // 两次都失败 → 降级（strict 模式由 build* 抛出）
}

/* ── 选诗：poems/ 语料库，按 index.json 作者粒度均匀抽 ──
 * 先 hash(date+盐) 抽作者（读取失败/池空按步进换下一位，步长与桶长互质必扫全
 * 表），再 hash(date+盐+文件名) 在作者名下抽篇。古典沿搜韵时代的篇幅闸：体裁
 * 须带诗/词/曲/歌/吟/行/府 字样、正文 8–240 字，剔掉文赋表这类散文。 */
async function pickBucket(date, bucket, salt) {
    const authors = (await getIndex()).buckets?.[bucket] || [];
    if (!authors.length) throw new Error(`语料索引没有 ${bucket} 分桶`);
    const step = [7, 5, 11, 13, 17, 19].find(s => authors.length % s !== 0) || 1;
    const h = hash(date + salt);
    for (let i = 0; i < authors.length; i++) {
        const a = authors[(h + i * step) % authors.length];
        try {
            const data = await loadJson(a.file);
            const pool = (data.poems || []).filter(p => {
                if (!p.title || !Array.isArray(p.stanzas) || !p.stanzas.length) return false;
                if (bucket !== 'zhClassical') return true;
                const len = p.stanzas.join('\n').length;
                return len >= 8 && len <= 240 && /[诗词曲歌吟行府]/.test(p.type || '');
            });
            if (!pool.length) throw new Error('名下没有合适篇幅的作品');
            const poem = pool[hash(`${date}${salt}:${a.file}`) % pool.length];
            const info = await loadJson(a.file.replace(/poems\.json$/, 'author.json'))
                .catch(() => ({})); // 简介缺失不影响出诗
            return { poem, author: data.author || info.author, info };
        } catch (err) {
            console.warn(`  [${bucket}] ${a.file} 不可用（${err.message}），换下一位`);
        }
    }
    throw new Error(`语料分桶 ${bucket} 全部尝试失败`);
}

/* 中文·古典的头部行是「朝代 · 作者 · 体裁」 */
async function pickZhClassical(date) {
    const { poem, author, info } = await pickBucket(date, 'zhClassical', ':zh');
    return {
        meta: [info.dynasty, author, poem.type].filter(Boolean).map(mdSafe).join(' · '),
        title: trim(poem.title),
        stanzas: poem.stanzas,
    };
}

/* 现代 / 英 / 德通用：「作者 · 生卒 · 年份」（年份数据没有就自动省略） */
async function pickListed(date, bucket, salt) {
    const { poem, author, info } = await pickBucket(date, bucket, salt);
    return {
        meta: [author, info.years, poem.year].filter(Boolean).map(mdSafe).join(' · '),
        title: trim(poem.title),
        stanzas: poem.stanzas,
    };
}

/* 单日四页的选诗一览（不注释）：batch --plan 打印给 Claude 逐首写
 * daily/{月}/notes.json（键 = `${选诗日期}:${kind}`，en/de 用组首日）。 */
export async function planDay(date) {
    const { start } = periodOf(date);
    const [zh, zhModern, en, de] = await Promise.all([
        pickZhClassical(date), pickListed(date, 'zhModern', ':zh-modern'),
        pickListed(start, 'en', ':en'), pickListed(start, 'de', ':de'),
    ]);
    return { zh, zhModern, en, de };
}

/* ── 四页组页：各自选诗 + 注释（并行），返回 {file, md, log} ──
 *    opts.gen 换页脚的生成方式标注；opts.strict = true 时注释失败直接抛
 *    （批量预生成用，宁缺勿滥）。 */

const frontMatter = (date, lang, title = '朝华章') => [
    '---', `title: ${title}`, `date: ${date} 06:00:00`, 'type: "page"',
    'layout: poem-daily', `lang: ${lang}`, '---', '',
];

function sections(anno, translationHeading) {
    const md = [];
    if (anno && Array.isArray(anno.notes) && anno.notes.length) {
        md.push('### 注释', '');
        anno.notes.forEach(n => {
            if (Array.isArray(n) && n[0]) md.push(`- **${mdSafe(n[0])}**：${mdSafe(n[1])}`);
        });
        md.push('');
    }
    if (anno && anno.translation) {
        md.push(translationHeading, '');
        // 译文按诗节排版：空行分段、段内行尾硬换行，与上方诗体一致（不再一行撑一段）
        anno.translation.split(/\n\s*\n/)
            .map(g => g.split(/\n+/).map(l => l.trim()).filter(Boolean).join('  '))
            .filter(Boolean)
            .forEach(p => md.push(mdSafe(p), ''));
    }
    if (anno && anno.brief) md.push('### 简析', '', mdSafe(anno.brief), '');
    return md;
}

/* 中文·古典：日更 → /poem-daily/（index.md，主入口） */
export async function buildZh(date, opts = {}) {
    const gen = opts.gen || '批量预生成';
    const md = [...frontMatter(date, 'zh-classical')];
    const p = await pickZhClassical(date);
    const anno = await annotate('zh', date, p.meta, p.title, p.stanzas.join('\n'));
    if (opts.strict && !anno) throw new Error('GLM 注释失败（strict 拒收，重跑即补）');
    md.push(`## 《${mdSafe(p.title)}》`, '', mdSafe(p.meta), '',
        ...quoteBlock(p.stanzas), '', ...sections(anno, '### 白话翻译'), '');
    md.push('---', '', `选诗：古典语料（来自[搜韵](https://cnkgraph.com)）`
        + (anno ? ` · 注释翻译：${anno.model}（${gen}）` : ' · 自动选诗'), '');
    return { file: 'index.md', md, log: `中文(古典) ${date} → [${p.meta}]《${p.title}》` };
}

/* 中文·现代：日更 → /poem-daily/modern/（新诗不要白话翻译，赏析单独成段） */
export async function buildZhModern(date, opts = {}) {
    const gen = opts.gen || '批量预生成';
    const md = [...frontMatter(date, 'zh-modern', '朝华章 · 现代')];
    const p = await pickListed(date, 'zhModern', ':zh-modern');
    const anno = await annotate('modern', date, p.meta, p.title, p.stanzas.join('\n\n'));
    if (opts.strict && !anno) throw new Error('GLM 注释失败（strict 拒收，重跑即补）');
    md.push(`## 《${mdSafe(p.title)}》`, '', `${mdSafe(p.meta)} 年`, '', ...quoteBlock(p.stanzas), '');
    if (anno && anno.notes.length) {
        md.push('### 注释', '');
        anno.notes.forEach(n => {
            if (Array.isArray(n) && n[0]) md.push(`- **${mdSafe(n[0])}**：${mdSafe(n[1])}`);
        });
        md.push('');
    }
    if (anno && anno.brief) md.push('### 赏析', '', mdSafe(anno.brief), '');
    md.push('---', '', `选诗：现代语料（来自[Github](https://github.com/sheepzh/poetry)）`
        + (anno ? ` · 注释赏析：${anno.model}（${gen}）` : ' · 自动选诗'), '');
    return { file: 'modern.md', md, log: `中文(现代) ${date} → [${p.meta}]《${p.title}》` };
}

/* 英德两页：六天一更 → 选诗日期用组首日（组内同一首），页脚标注本期区间 */
export async function buildEn(date, opts = {}) {
    const gen = opts.gen || '批量预生成';
    const { start, label } = periodOf(date);
    const p = await pickListed(start, 'en', ':en');
    const anno = await annotate('en', start, p.meta, p.title, p.stanzas.join('\n\n'));
    if (opts.strict && !anno) throw new Error('GLM 注释失败（strict 拒收，重跑即补）');
    const md = [...frontMatter(date, 'en', '朝华章 · English'),
        `## "${mdSafe(p.title)}"`, '', mdSafe(p.meta), '', ...quoteBlock(p.stanzas), '',
        ...sections(anno, '### 中文译文'), '',
        '---', '', `选诗：英文语料（来自[PoetryDB](https://poetrydb.org)）`
        + (anno ? ` · 注释翻译：${anno.model}（${gen}）` : ' · 自动选诗')
        + ` · 本期 ${label}`, ''];
    return { file: 'en.md', md, log: `英文 ${label} → [${p.meta}] "${p.title}"` };
}

export async function buildDe(date, opts = {}) {
    const gen = opts.gen || '批量预生成';
    const { start, label } = periodOf(date);
    const p = await pickListed(start, 'de', ':de');
    const anno = await annotate('de', start, p.meta, p.title, p.stanzas.join('\n\n'));
    if (opts.strict && !anno) throw new Error('GLM 注释失败（strict 拒收，重跑即补）');
    const md = [...frontMatter(date, 'de', '朝华章 · Deutsch'),
        `## „${mdSafe(p.title)}“`, '', mdSafe(p.meta), '', ...quoteBlock(p.stanzas), '',
        ...sections(anno, '### 中文译文'), '',
        '---', '', `选诗：德语语料（Gutenberg project）`
        + (anno ? ` · 注释翻译：${anno.model}（${gen}）` : ' · 自动选诗')
        + ` · 本期 ${label}`, ''];
    return { file: 'de.md', md, log: `德文 ${label} → [${p.meta}] „${p.title}“` };
}
