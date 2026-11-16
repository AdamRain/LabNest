# 第三方组件与素材

仓库根目录的 MIT License 适用于本项目原创代码、文档和通用研栖标识。下列第三方文件保留各自的版权与许可，不以项目的 MIT 声明替换。

## Preline Collapse

- 文件：`public/vendor/preline-collapse-5.0.0.mjs`。
- 上游：<https://preline.co/>，Preline Labs Ltd.。
- 完整声明：[preline-collapse.LICENSE](public/vendor/preline-collapse.LICENSE)。
- 该分发文件的声明同时列出 MIT 和 Preline UI Fair Use License，仓库完整保留原文件。重新分发时请同时保留该声明，并按所采用的许可使用。

## Fandol 中文字体

- 文件：`src/fonts/FandolHei-Regular.otf`，Fandol 0.3，未修改。
- 作者：Fandol team，Clerk Ma 与 Jie Su。
- 许可证：GPL v3，附字体嵌入例外，原文见 [Fandol-COPYING.txt](src/fonts/Fandol-COPYING.txt)。
- 原始说明：[Fandol-README.txt](src/fonts/Fandol-README.txt)。
- 对应上游及源文件：<https://github.com/clerkma/fandol>，<https://ctan.org/pkg/fandol>。

该字体用于生成中文 PDF、Word 简历。嵌入例外的适用范围以原许可为准；原字体不重新许可为 MIT。替换字体时应确认其分发及嵌入许可。

## npm 依赖

`docx`、`nodemailer`、`pdfkit` 及其依赖由 `package-lock.json` 固定版本，使用 `npm ci` 安装。发布包不包含 `node_modules`；各包的许可证随依赖安装保留。本项目未把依赖重新声明为 MIT。

## Demo 内容及标识

Demo 的姓名、单位、项目、成果、讨论、会议、头像与资料均为本项目构造的示例，不取自实际运行的数据库。会议与投稿日期不代表任何真实会议安排。

研栖 / LabNest 的通用图形标识为本项目新生成的资产，并按本项目 MIT 许可证提供；原部署实例的实验室 Logo、机构名称和人员照片未收入本仓库。
