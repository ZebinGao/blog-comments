# blog-comments

博客的数据仓库。

- **Issues** —— 评论
- **poems/** —— 语料库（中/英/德 104 位作者 23917 首），结构与维护见 [poems/README.md](poems/README.md)
- **daily/** —— 月度预生成缓存（`{月}/{日期}.json` 存三语四页成品），博客 CI 每日拉取
- **tools/** —— 语料收割（搜韵 / sheepzh 诗库 / PoetryDB / PG 德语三本）、批量预生成与索引脚本

语料增删后在仓库根目录跑 `node tools/poem-index.mjs` 重建索引，再提交。
