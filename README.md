# blog-comments

博客的数据仓库（公开）。

- **Issues** —— 「此刻」与评论，博客每日构建时拉取
- **poems/** —— 「朝华章」语料库（中/英/德 58 位作者 19897 首，均公版），结构与维护见 [poems/README.md](poems/README.md)
- **tools/** —— 语料收割与索引脚本

语料增删后在仓库根目录跑 `node tools/poem-index.mjs` 重建索引，再提交。
