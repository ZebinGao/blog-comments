# 朝华章语料库

博客「朝华章」（每日一诗：中文古典 / 中文现代 / English / Deutsch）的选诗池。
语料收割自公开来源，**全部为公有领域作品**（中文作者均逝世满 50 年，欧美作者均逝世满 70 年）。

## 目录结构

```
poems/
  index.json                 全量清单（选诗脚本按此做确定性抽取；语料变更后必须重建）
  zh/classical/{朝代}/{作者}/ 中文古典（收割自搜韵开放接口）
  zh/modern/{流派}/{作者}/     中文新诗（收割自 sheepzh/poetry，白名单限公版作者）
  en/{作者}/                  英文（收割自 PoetryDB）
  de/{作者}/                  德文（手工录入）
```

`zh/modern` 的流派层按文学史通行分期（《中国现代文学三十年》+ 洪子诚《中国
当代文学史》）：**白话初创 9 · 新月派 8 · 现代派 3 · 象征派 2 · 左翼 1 ·
十七年 1**。临期解禁将入：李金发→象征派、郭小川→十七年（2027-01），
何其芳→现代派（2028-01）。

每位作者一个目录，两个文件：

- `poems.json` —— `{"author": "…", "poems": [{"title", "type"?, "year"?, "stanzas": ["节内行\\n行", …]}]}`
- `author.json` —— `{"author", "years", "dynasty"?, "intro"}` 作者简介

## 维护

- **加诗**：往对应作者的 `poems.json` 数组里追加；**加作者**：建目录写两个 json
- **任何增删之后**：在本仓库根目录跑 `node tools/poem-index.mjs` 重建 `index.json`，一起提交
- 收割脚本（`tools/harvest-souyun.mjs` / `tools/harvest-poetrydb.mjs`，在本仓库 tools/ 下）可重跑补量，幂等覆盖 `poems.json`、不碰手补的 `author.json`
