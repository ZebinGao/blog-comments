#!/usr/bin/env node
/**
 * ── 一次性合并：每诗一文件 → 每作者两文件（poems.json + author.json）──
 *
 * 2026-11-03 收割脚本最初按"一首诗一个 json"落盘，文件数近两万，git 不堪重负。
 * 改为按作者归拢：poems/{lang}/{...}/{作者}/poems.json（全部诗）+ author.json
 * （作者简介）。本脚本读旧结构、写新结构、删旧文件；重跑安全（旧文件没了就是做完了）。
 *
 * 作者简介表（AUTHORS）是 author.json 的唯一来源：后续新增作者直接在 blog-comments
 * 里手写 author.json 即可，收割脚本只在文件缺失时写个只有名字的占位。
 */
'use strict';

import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'poems');

/* 作者简介：dynasty 仅中文古典有；years 生卒；intro 一句话定位。
 * 前四位键 = 分桶，便于索引脚本复用（不 import 本脚本，字段自洽）。 */
const AUTHORS = {
    'zhClassical': {
        '李白': ['701–762', '唐', '字太白，号青莲居士。盛唐浪漫主义巅峰，想象奇逸，人称"诗仙"。'],
        '杜甫': ['712–770', '唐', '字子美，自号少陵野老。沉郁顿挫，人称"诗圣"，诗称"诗史"。'],
        '王维': ['701–761', '唐', '字摩诘。盛唐山水田园诗代表，"诗中有画"，兼精音律绘画。'],
        '白居易': ['772–846', '唐', '字乐天，号香山居士。语言平易，新乐府运动倡导者。'],
        '李商隐': ['约813–858', '唐', '字义山，号玉谿生。晚唐深婉朦胧，无题诗著称。'],
        '杜牧': ['803–852', '唐', '字牧之，号樊川居士。晚唐俊爽峭健，与李商隐并称"小李杜"。'],
        '孟浩然': ['689–740', '唐', '襄阳人，终身布衣。盛唐山水田园诗先行者。'],
        '王昌龄': ['约698–757', '唐', '字少伯。七绝圣手，边塞诗著称。'],
        '刘禹锡': ['772–842', '唐', '字梦得。中唐诗人，咏史怀古与民歌体《竹枝词》兼善。'],
        '柳宗元': ['773–819', '唐', '字子厚，河东人。古文大家，诗风清峻简淡。'],
        '苏轼': ['1037–1101', '宋', '字子瞻，号东坡居士。诗词文书画俱冠绝一时，豪放旷达。'],
        '陆游': ['1125–1210', '宋', '字务观，号放翁。南宋爱国诗人，存诗逾万首为古今之冠。'],
        '辛弃疾': ['1140–1207', '宋', '字幼安，号稼轩。豪放词代表，与苏轼并称"苏辛"。'],
        '李清照': ['1084–约1155', '宋', '号易安居士。婉约词宗，号"一代词宗"。'],
        '王安石': ['1021–1086', '宋', '字介甫，号半山。北宋政治家，诗风瘦硬精工。'],
        '欧阳修': ['1007–1072', '宋', '字永叔，号醉翁。北宋文坛领袖，诗文平易流畅。'],
        '黄庭坚': ['1045–1105', '宋', '字鲁直，号山谷道人。江西诗派开山，主张点铁成金。'],
        '范成大': ['1126–1193', '宋', '字致能，号石湖居士。南宋四大家之一，田园诗著称。'],
        '杨万里': ['1127–1206', '宋', '字廷秀，号诚斋。创"诚斋体"，活泼自然。'],
        '纳兰性德': ['1655–1685', '清', '字容若，满洲正黄旗。清词第一大家，哀感顽艳。'],
        '龚自珍': ['1792–1841', '清', '字璱人，号定盦。近代思想先驱，"但开风气不为师"。'],
        '曹操': ['155–220', '汉', '字孟德。汉末政治家，建安文学开创者，慷慨悲凉。'],
        '王勃': ['约650–676', '唐', '字子安。初唐四杰之首，《滕王阁序》名世。'],
        '李贺': ['约790–816', '唐', '字长吉。人称"诗鬼"，奇诡冷艳。'],
        '李煜': ['937–978', '五代', '南唐后主。变伶工之词为士大夫之词，字字血泪。'],
        '元好问': ['1190–1257', '金', '字裕之，号遗山。金末文宗，"问世间情为何物"出其笔下。'],
        '马致远': ['约1250–1321后', '元', '号东篱。元曲四大家之一，《天净沙·秋思》称"秋思之祖"。'],
        '张养浩': ['1270–1329', '元', '字希孟，号云庄。元代散曲家，《山坡羊·潼关怀古》传世。'],
        '白朴': ['1226–约1306', '元', '字太素，号兰谷。元曲四大家之一，杂剧散曲兼善。'],
        '郑燮': ['1693–1765', '清', '号板桥。"扬州八怪"之一，诗书画三绝，关心民瘼。'],
        '袁枚': ['1716–1798', '清', '字子才，号简斋、随园主人。"性灵说"倡导者。'],
        '黄景仁': ['1749–1783', '清', '字汉镛、仲则，号鹿菲子。穷愁悲凉，包世臣推为"清代第一"。'],
    },
    'zhModern': {
        '徐志摩': ['1897–1931', '新月派代表，《再别康桥》传诵至今，追求诗歌的音韵与意象之美。'],
        '闻一多': ['1899–1946', '新月派诗人、学者，提出音乐美/绘画美/建筑美"三美"，著《红烛》《死水》。'],
        '戴望舒': ['1905–1950', '现代派象征主义诗人，以《雨巷》得名"雨巷诗人"。'],
        '李叔同': ['1880–1942', '弘一法师。近代艺术全才，《送别》词作者。'],
        '刘半农': ['1891–1934', '新文化运动干将，"她"字的首创者之一。'],
        '林徽因': ['1904–1955', '建筑学家、诗人，《你是人间的四月天》广为传诵。'],
    },
    'en': {
        'William Shakespeare': ['1564–1616', '英国剧作家与诗人，154 首十四行诗与数十部戏剧流传后世。'],
        'William Blake': ['1757–1827', '英国浪漫主义先声，诗人兼版画家，《天真与经验之歌》作者。'],
        'William Wordsworth': ['1770–1850', '湖畔派领袖，英国浪漫主义奠基者，《序曲》作者。'],
        'John Keats': ['1795–1821', '英年早逝的浪漫主义天才，以颂诗著称，"美即是真"。'],
        'Percy Bysshe Shelley': ['1792–1822', '浪漫主义革命诗人，《西风颂》《致云雀》作者。'],
        'George Gordon, Lord Byron': ['1788–1824', '拜伦勋爵，浪漫主义的叛逆者，《唐璜》作者。'],
        'John Donne': ['1572–1631', '玄学派诗歌代表，奇喻（conceit）大师。'],
        'Robert Burns': ['1759–1796', '苏格兰民族诗人，《友谊地久天长》原作者。'],
        'Emily Dickinson': ['1830–1886', '美国阿默斯特隐士诗人，身后成名，现代诗的先声。'],
        'Edgar Allan Poe': ['1809–1849', '美国哥特诗人、侦探小说鼻祖，《乌鸦》作者。'],
        'Christina Rossetti': ['1830–1894', '英国先拉斐尔派女诗人，《妖精集市》作者。'],
        'Samuel Coleridge': ['1772–1834', '湖畔派诗人，《忽必烈汗》《古舟子咏》作者。'],
        'Edward Lear': ['1812–1888', '荒诞诗（nonsense verse）与五行打油诗（limerick）鼻祖。'],
        'Lewis Carroll': ['1832–1898', '《爱丽丝漫游奇境》作者，nonsense 诗双璧之一（《炸蟒蛇》）。'],
        'Andrew Marvell': ['1621–1678', '形而上诗人，《致羞怯的情人》作者。'],
        'Robert Herrick': ['1591–1674', '保王党抒情诗人，"Gather ye rosebuds while ye may"传诵。'],
    },
    'de': {
        'Goethe': ['1749–1832', '德国文学的巅峰，魏玛古典主义代表，《浮士德》作者。'],
        'Heine': ['1797–1856', '德国晚期浪漫主义诗人，讽刺与柔情并存，《罗蕾莱》家喻户晓。'],
        'Rilke': ['1875–1926', '奥地利象征主义诗人，《杜伊诺哀歌》与《物诗》大师。'],
        'Eichendorff': ['1788–1857', '德国晚期浪漫主义诗人，夜、月与漫游的歌手。'],
        'Mörike': ['1804–1875', '施瓦本诗人，细腻的自然感与宗教情怀。'],
        'Uhland': ['1787–1862', '施瓦本浪漫派，民歌体叙事诗《好战友》作者。'],
    },
};

/* 各分桶的目录前缀与 poems.json 里每首诗保留的字段 */
const BUCKETS = [
    ['zhClassical', 'zh/classical', p => ({ title: p.title, type: p.type || '', stanzas: p.stanzas })],
    ['zhModern', 'zh/modern', p => ({ title: p.title, year: p.year || null, stanzas: p.stanzas })],
    ['en', 'en', p => ({ title: p.title, stanzas: p.stanzas })],
    ['de', 'de', p => ({ title: p.title, year: p.year || null, stanzas: p.stanzas })],
];

async function main() {
    let authors = 0, poems = 0;
    for (const [bucketKey, prefix, keep] of BUCKETS) {
        const base = path.join(ROOT, prefix);
        const depth = prefix === 'zh/classical' ? 1 : 0; // 需要再下钻几层到作者目录
        const dirs = [];
        const collect = async (d, left) => {
            for (const e of await readdir(d, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                if (left === 0) dirs.push(path.join(d, e.name));
                else await collect(path.join(d, e.name), left - 1);
            }
        };
        await collect(base, depth);

        for (const dir of dirs) {
            const name = path.basename(dir);
            const files = (await readdir(dir)).filter(f => f.endsWith('.json')
                && f !== 'poems.json' && f !== 'author.json').sort();
            if (!files.length) continue;

            const merged = [];
            for (const f of files) {
                const p = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
                merged.push(keep(p));
            }
            await writeFile(path.join(dir, 'poems.json'),
                JSON.stringify({ author: name, poems: merged }, null, 2) + '\n', 'utf8');

            // 表项格式不齐：古典 [生卒, 朝代, 简介]，其余 [生卒, 简介]——按长度解包
            const info = AUTHORS[bucketKey][name];
            const authorJson = info
                ? {
                    author: name,
                    years: info[0],
                    ...(info.length > 2 ? { dynasty: info[1] } : {}),
                    intro: info[info.length - 1],
                }
                : { author: name }; // 表里没有：写占位，之后手补
            await writeFile(path.join(dir, 'author.json'),
                JSON.stringify(authorJson, null, 2) + '\n', 'utf8');

            for (const f of files) await rm(path.join(dir, f));
            authors++;
            poems += merged.length;
            console.log(`  ${prefix}/${name}：${merged.length} 首`);
        }
    }
    console.log(`合并完成：${authors} 位作者、${poems} 首。`);
    console.log('下一步：node tools/poem-index.mjs 重建索引。');
}

main().catch(err => {
    console.error('合并失败：', err.message);
    process.exit(1);
});
