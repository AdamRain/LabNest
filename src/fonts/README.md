# 简历中文字体

`FandolHei-Regular.otf` 是未修改的 Fandol 0.3 字体，随项目分发，原始字体项目及完整许可见下方链接与文件。

- 作者：Fandol team，Clerk Ma 与 Jie Su。
- 上游项目与源代码：https://github.com/clerkma/fandol
- 公开分发包：https://ctan.org/pkg/fandol
- 许可：GPL v3 加字体嵌入例外，完整原文保留在 `Fandol-COPYING.txt`。
- 原始说明：`Fandol-README.txt`。

字体仅由服务端生成简历时读取，不通过网页静态资源接口分发。PDF 中只嵌入所用字形的子集。
Word 文件保持可编辑，并携带字体，以便在未安装该字体的电脑上保留中文排版。

如需更换 PDF 字体，可设置 `LAB_RESUME_FONT` 为有权嵌入的 TTF/OTF/TTC 文件绝对路径；
TTC 字体合集可另外用 `LAB_RESUME_FONT_FACE` 指定字体名称。
