# Linux 配置模板

完整步骤见 [部署说明](../../docs/DEPLOYMENT.md)。本目录仅提供通用模板，不包含任何现有站点的运行配置、账号、数据库或证书。

| 文件 | 用途 |
| --- | --- |
| `app.env.example` | 复制到 `/etc/labnest/app.env`，填写真实 HTTPS 根地址及独立数据库位置 |
| `labnest.service` | 系统级 systemd 服务，以专用 `labnest` 用户运行 |
| `Caddyfile.example` | 同机 HTTPS 反向代理，仅转发到 `127.0.0.1:4173` |

示例目录为 `/srv/labnest/app`（代码）和 `/srv/labnest/data`（私有数据）。环境模板的根地址故意留空，配置完整前应用会拒绝启动。

安装前核对 Node.js 24+ 的绝对路径、服务账号、目录权限、域名解析和证书；修改模板中的示例域名。`/usr/bin/node` 须替换为目标机器上服务账号能够执行的 Node 路径。

不要把 Demo 数据库或公开 Demo 口令用于多人部署，也不要将运行生成的邮件配置、数据库或私钥提交到仓库。
