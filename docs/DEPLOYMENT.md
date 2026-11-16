# 研栖 · LabNest 部署说明

本文介绍如何从空库建立自己的站点，以及 Linux 上的 HTTPS 运行方式。演示体验见 [DEMO.md](../DEMO.md)，日常操作见 [使用手册](USER_GUIDE.md)。所有域名、账号和目录均为通用示例。

Demo 启动器只供本机体验，使用独立的 `data/demo.sqlite` 和公开口令。正式站应从空库开始，创建独立账号；不要把演示数据库复制成正式数据库。

## 1. 环境与数据位置

- Node.js **24 或更新版本**，以及 npm。
- 单个应用实例和本地 SQLite 数据库，无需安装独立数据库服务。
- 服务账号须能读取代码、字体及静态资源，并能写入数据库所在目录。
- 多人访问使用已配置证书的 HTTPS 入口。应用可以直接使用 TLS，也可以位于明确受信任的同机反向代理后。

以下文件包含运行数据，应保存在私有目录中，不进入 GitHub：

| 内容 | 默认位置或规则 |
| --- | --- |
| 业务数据库 | 默认 `data/lab.sqlite`，可由 `LAB_DB_PATH` 改为绝对路径 |
| 演示数据库 | `data/demo.sqlite`，与正式数据分开 |
| SQLite 辅助文件 | 数据库旁的 `-wal`、`-shm` 文件 |
| 邮件配置 | 数据库完整路径后追加 `.mail.json`，例如 `lab.sqlite.mail.json` |
| 环境配置 | 本机 `.env`，或由 `LAB_ENV_FILE` 指定的私有文件 |
| 证书私钥、备份和运行日志 | 由维护者放在限制访问的目录中 |

周报附件、生活照和已上传的系统 Logo 存在数据库中，数据库备份须按私有资料保管。邮件配置是单独文件，需要另行备份。

## 2. 本机空库：先建立自己的账号

在一个新的项目副本中运行：

```bash
npm ci
cp .env.example .env
npm run admin -- admin@example.com "实验室管理员"
npm start
```

打开 **http://127.0.0.1:4173/**。管理员命令会生成随机初始密码，只在终端显示，请妥善保存。把示例邮箱和姓名改为本人可用的信息。登录后在“全部用户”创建教师，或由教师注册后审批；学生随后自行注册。

默认数据库是 `data/lab.sqlite`。`npm start` 会读取 `.env`，并以本机开发模式监听回环地址。此模式不用于供校园网或公网用户登录。

### 2.1 自定义数据库时，让各命令使用同一份环境

管理员和备份命令**不会自行加载 `.env`**。上面的默认命令只适用于默认数据库，或相关变量已经存在于进程环境的情况。

如果在 `.env` 中修改了 `LAB_DB_PATH`，创建管理员及备份时明确加载同一环境文件：

```bash
node --env-file=.env src/create-admin.mjs admin@example.com "实验室管理员"
node --env-file=.env src/backup.mjs /path/to/private-backups/lab-before-upgrade.sqlite
```

备份目录须事先存在，目标文件名须尚未使用。不要因为账号不存在而反复创建管理员；先核对服务和命令读取的是否为同一个数据库。Node 环境文件选项的行为见 [Node.js 官方说明](https://nodejs.org/api/cli.html#--env-filefile)。

## 3. Linux 正式部署的目录约定

本节是首次安装的通用示例，假设使用支持 systemd 的 Linux，由维护者执行安装操作：

| 项目 | 示例值 |
| --- | --- |
| 专用服务用户与组 | `labnest` |
| 代码目录 | `/srv/labnest/app` |
| 私有数据目录 | `/srv/labnest/data` |
| 环境文件 | `/etc/labnest/app.env` |
| systemd 服务 | `labnest.service` |
| 应用监听 | `127.0.0.1:4173` |
| 访客和成员入口 | `https://lab.example.org`，须替换为自己的真实域名 |

服务以普通专用用户运行，代码目录由部署维护者管理，数据目录只授权服务账号访问。不要给服务账号交互式管理员权限。

### 3.1 安装源代码与依赖

先确认系统安装了 Node.js 24+：

```bash
node --version
command -v node
```

下文默认 Node 位于 `/usr/bin/node`。如果实际路径不同，请同时修改 systemd 模板及下面初始化、备份命令中的路径。选用服务账号可以执行的位置；模板启用了 `ProtectHome=true`，不适合依赖某个个人主目录中的 Node 安装。

从新的源码副本安装并检查依赖：

```bash
git clone https://github.com/AdamRain/LabNest.git LabNest-production-source
cd LabNest-production-source
npm ci --omit=dev
npm test
```

在这个正式安装的源码副本中不运行 Demo。接着建立专用用户和目录；如果已存在同名账号或站点，应先核对现有用途，不要覆盖：

```bash
sudo useradd --system --user-group --home-dir /srv/labnest --shell /usr/sbin/nologin labnest
sudo install -d -o root -g root -m 0755 /srv/labnest/app
sudo install -d -o labnest -g labnest -m 0700 /srv/labnest/data
sudo install -d -o root -g labnest -m 0750 /etc/labnest
sudo cp -R src public package.json package-lock.json node_modules /srv/labnest/app/
sudo install -o root -g labnest -m 0640 deploy/linux/app.env.example /etc/labnest/app.env
```

这一步只复制应用运行文件和依赖，不复制 `.env`、演示数据或运行目录。保留源码副本用于测试和后续更新。

### 3.2 配置网站地址

编辑 `/etc/labnest/app.env`。模板的根地址故意留空，配置不完整时应用拒绝启动；请填写用户将实际访问的 HTTPS 地址。

同机 Caddy 反向代理的关键配置如下，把域名替换为自己的：

```dotenv
NODE_ENV=production
LAB_HOST=127.0.0.1
LAB_PORT=4173
LAB_TRANSPORT_MODE=proxy
LAB_TRUSTED_PROXIES=127.0.0.1
LAB_CANONICAL_URL=https://lab.example.org
LAB_PUBLIC_URL=https://lab.example.org
LAB_DB_PATH=/srv/labnest/data/lab.sqlite
LAB_PUBLIC_HOME=0
LAB_PREVIEW=0
LAB_CALENDAR_SYNC=1
```

`LAB_CANONICAL_URL`、邮件设置中的网站地址和实际 HTTPS 入口应保持一致。填写根地址，不带页面路径。`proxy` 模式下 TLS 在反向代理终止，不填写应用的证书路径，也不把应用后端改为 `0.0.0.0`。

使用 `sudoedit /etc/labnest/app.env` 等本机编辑方式填写。文件权限保留为 `root:labnest`、`0640`，所在目录 `0750`；不要通过聊天、Issue、截图或提交记录交付真实环境文件。

### 3.3 在独立空库中创建首个管理员

在服务启动前，明确使用正式环境文件创建管理员：

```bash
sudo -u labnest /usr/bin/node --env-file=/etc/labnest/app.env /srv/labnest/app/src/create-admin.mjs admin@example.com "实验室管理员"
```

用自己的邮箱替换示例值。命令只创建管理员与账号所需表，首次启动会补齐其他业务表。随机初始密码只交给账号本人；不要把包含密码的终端输出上传到仓库或贴到公开日志。

### 3.4 安装 systemd 服务

从源码副本中复制模板，核对 Node 路径后启动：

```bash
sudo install -m 0644 deploy/linux/labnest.service /etc/systemd/system/labnest.service
sudo systemctl daemon-reload
sudo systemctl enable --now labnest.service
sudo systemctl status labnest.service --no-pager
```

查看日志：

```bash
sudo journalctl -u labnest.service -n 100 --no-pager
```

该模板使用系统级服务命令，没有 `--user`。服务设置了只读系统目录，允许写入 `/srv/labnest/data`；自定义数据路径时，也须同步调整目录权限和 `ReadWritePaths`。

## 4. 配置 HTTPS 反向代理

安装目标系统支持的 Caddy 版本，参考 [Caddy 官方安装说明](https://caddyserver.com/docs/install)。将 [Caddyfile 模板](../deploy/linux/Caddyfile.example) 中的域名替换后，放到该机的 Caddy 配置位置。

模板适用于 Caddy 直接接收客户端连接、Node 与 Caddy 位于同一机器的情况：

```caddyfile
{
    auto_https disable_redirects
}

http://lab.example.org {
    route {
        @safe method GET HEAD
        redir @safe https://lab.example.org{uri} 308
        respond "Please reopen this page using HTTPS before submitting." 426
    }
}

https://lab.example.org {
    request_body {
        max_size 32MB
    }

    reverse_proxy 127.0.0.1:4173 {
        header_up X-Forwarded-For {http.request.remote.host}
        header_up X-Forwarded-Proto https
        header_up -Forwarded
        header_up -X-Real-IP
    }
}
```

32 MB 是整个请求的上限，用于容纳最多 5 个、每个 5 MiB 的附件及表单开销；应用仍逐个验证文件类型、大小和数量。[请求体上限](https://caddyserver.com/docs/caddyfile/directives/request_body)和[代理头配置](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)见 Caddy 官方文档。

### 4.1 域名、证书与网络

公网域名须指向实际服务器，满足 Caddy 自动签发证书的条件后，可以使用默认自动 HTTPS。校园内网域名如不能完成公开验证，应由网络维护者提供客户端信任的证书与完整证书链，并在模板中启用：

```caddyfile
tls /etc/caddy/certs/labnest.fullchain.pem /etc/caddy/certs/labnest.key
```

证书私钥放在代码目录之外，只授权 Caddy 服务账号读取。不要用关闭证书检查或让用户忽略浏览器警告代替部署验收。网络入口通常只需对外提供 HTTPS 的 443，以及模板使用的 HTTP 引导入口 80；应用端口 4173 只监听回环，不向外开放。

如果 Caddy 前面还有负载均衡、CDN 或其他代理，此模板的客户端地址假设已改变，应重新配置并核验代理信任链，不能直接信任任意客户端传来的转发头。

### 4.2 验证与加载

在目标机器使用它实际安装的 Caddy 验证配置，例如：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

这些文件是部署模板，不代表已经在某台服务器配置了域名或证书。应用首次上线后，至少确认：

1. 用实际 HTTPS 域名打开登录、注册及 `/portal`，浏览器没有证书错误。
2. 管理员、教师和已审核学生能登录并正常退出，工作台按角色显示。
3. 待审核账号看不到内部通知、动态和其他学生资料。
4. 教师只能处理主、副指导关系内的学生，附件同样受权限限制。
5. 周报提交、修改、附件上传与下载、简历导出正常；首次正式试用使用自己的测试资料。
6. Cookie 带 `Secure`、`HttpOnly`、`SameSite=Lax`；伪造来源头或直接访问后端不能绕过 HTTPS 要求。
7. HTTP GET/HEAD 引导到固定 HTTPS 域名，HTTP POST 被拒绝，用户始终从 HTTPS 登录。

## 5. 邮件、门户与其他运行选项

| 设置 | 用途 |
| --- | --- |
| `LAB_PUBLIC_HOME=0` | 首页直接登录；门户保留在 `/portal` |
| `LAB_PUBLIC_HOME=1` | 使用公开门户作为首页，统一登录仍在 `/login` |
| `LAB_CALENDAR_SYNC=1` | 启用会议订阅的自动检查与同步 |
| `LAB_CALENDAR_SYNC=0` | 停止自动联网同步，教师仍可从界面手动同步 |
| `LAB_PREVIEW=0` | 正式站不启用演示预览标记 |
| `LAB_UNDERGRAD_ID_LENGTH`、`LAB_GRAD_ID_LENGTH` | 可选的学号位数配置，须同时设置有效值，本科学号位数须更长 |

修改环境配置后重启应用服务生效：

```bash
sudo systemctl restart labnest.service
```

密码找回由管理员在“邮件设置”配置。SMTP 凭据保存后不回显；留空保留原授权码。启用后用本人的已绑定账号实际申请一次找回，检查收件和链接目标。后台已保存的邮件设置优先于环境变量，因此只改环境文件不能保证已保存的网站地址也随之更新。

如选择应用直接终止 HTTPS，使用 `LAB_TRANSPORT_MODE=tls`，同时提供 `LAB_TLS_CERT_FILE` 和 `LAB_TLS_KEY_FILE`，填写对应 HTTPS 根地址，并为服务账号设置私钥读取权限。不要混用 `tls` 与 `proxy` 的配置。发布版不依赖临时明文兼容配置，正常多人部署采用 HTTPS。

## 6. 备份与更新

### 6.1 备份数据库与配置

`src/backup.mjs` 使用 SQLite 备份接口生成数据库快照；不要在服务运行时只复制 `lab.sqlite` 主文件而忽略 WAL。命令不会覆盖已有目标文件，备份名称每次应唯一，父目录须预先建立。

Linux 示例：

```bash
sudo install -d -o labnest -g labnest -m 0700 /srv/labnest/data/backups
sudo -u labnest /usr/bin/node --env-file=/etc/labnest/app.env /srv/labnest/app/src/backup.mjs /srv/labnest/data/backups/lab-before-upgrade.sqlite
```

把示例文件名改为本次唯一名称。除数据库外，还应分别备份 `/etc/labnest/app.env`、存在时的 `/srv/labnest/data/lab.sqlite.mail.json`、服务配置及正在运行的代码版本。备份目录使用 `0700`、私有文件使用 `0600` 或仅运行组可读的权限，另留一份受控的异机备份。

备份会保留账号、密码哈希及私有附件，不能上传到公开仓库、Release 附件或 Issue。

### 6.2 更新顺序

1. 在独立源码目录取得新版本，按锁文件安装依赖并运行测试；需要演练时，在私有数据副本上验证，避免直接操作线上数据。
2. 记录当前代码版本、环境文件和服务配置。在维护窗口暂停写入并停止 `labnest.service`。
3. 用上一节的明确环境命令生成最终数据库快照，备份邮件配置及环境文件，保留上一版完整代码。
4. 将完整新运行代码安装到 `/srv/labnest/app`，保留外部数据目录和环境文件，不覆盖为 Demo 数据，不复制开发机的证书或配置。
5. 启动服务，查看日志，经实际 HTTPS 入口检查登录、权限和业务操作；确认通过后再结束维护窗口。

静态资源在应用启动时读取，模板模块也会被进程缓存，所以传完全部代码和资源后需要重启服务；仅替换 CSS 文件而不重启，可能仍显示旧版。

### 6.3 回退时保留新数据

回退前先停止写入并完整保留**当前数据库**，记录是否已经收到新注册、周报或其他业务更新。

- 仅外观等不改变数据结构的更新，可恢复上一版代码，继续使用当前数据库，再检查服务。
- 涉及数据结构或数据语义变化的更新，先确认旧代码是否兼容。不能把旧代码直接套到不兼容的新库。
- 如果发布后已经接收新数据，不能直接用发布前备份覆盖现库。应保留当前库，在隔离副本中设计迁移或向前修复，确认保留新记录后再恢复服务。
- 只有确认没有需要保留的新写入，或已完成新记录的受控迁移时，才考虑配套恢复历史代码和历史库。

首次部署、更新、回退和恢复都应记录所用版本、备份位置及验收结果。不要把真实数据和运行凭据混入源码发布包。
