# iframe-host

独立的 Node/Express iframe 承载页和访问审计后台，仅用于你自己控制的站点。

## 推荐目录结构

只维护一份源码，不需要复制一个长期存在的 `local_runtime` 源码目录：

```text
iframe-host/
├─ server.js
├─ public/
├─ package.json
├─ config.local.json       # 本地配置，不提交 Git
├─ config.production.json  # 生产配置，不提交 Git
├─ runtime-local/          # 本地日志，不提交 Git
└─ runtime-production/     # 生产日志，不提交 Git
```

本地和生产环境共用 `server.js`、后台页面及依赖锁文件，只通过配置文件和数据目录区分。这样修复或升级一次，两边会保持一致。

## 功能

- 首次运行交互式配置，并保存到 `config.json`
- 后续零参数运行：`npm start`
- 支持用环境变量覆盖配置
- 持久化记录访问时间、IP、User-Agent、来源页和设备摘要
- 管理员后台查看、刷新、弹窗查看详情和清空日志
- 自动按保留天数和最大记录数清理
- `TRUST_PROXY` 默认关闭，避免直接相信伪造的转发 IP
- 使用 `CONFIG_FILE` 切换本地/生产配置
- 使用 `DATA_DIR` 隔离本地/生产日志

## 安装和启动

```bash
cd iframe-host
npm install
npm start
```

首次启动会询问：

- 你的站点 URL
- 页面标题
- 监听端口
- 后台账号和密码
- 是否位于 Nginx 等反向代理后面

配置保存后，再次运行无需输入。

## 本地与生产配置

从模板复制两份配置：

```powershell
Copy-Item config.example.json config.local.json
Copy-Item config.example.json config.production.json
```

本地配置建议：

```json
{
  "target_url": "http://127.0.0.1:8080/",
  "title": "Local Test",
  "port": 3030,
  "admin_user": "admin",
  "admin_password": "LOCAL-STRONG-PASSWORD",
  "trust_proxy": false,
  "data_dir": "runtime-local",
  "retention_days": 7,
  "max_records": 1000
}
```

本地运行：

```powershell
$env:CONFIG_FILE="config.local.json"
npm start
```

生产配置建议使用不同端口、强密码和独立数据目录：

```json
{
  "target_url": "https://YOUR-DOMAIN/",
  "title": "Production Site",
  "port": 3030,
  "admin_user": "admin",
  "admin_password": "PRODUCTION-STRONG-PASSWORD",
  "trust_proxy": true,
  "data_dir": "runtime-production",
  "retention_days": 30,
  "max_records": 10000
}
```

生产运行：

```bash
CONFIG_FILE=config.production.json npm start
```

如果生产数据要放在代码目录之外：

```bash
CONFIG_FILE=config.production.json DATA_DIR=/var/lib/iframe-host npm start
```

## 地址

```text
承载页：http://127.0.0.1:3030/
管理页：http://127.0.0.1:3030/admin
健康检查：http://127.0.0.1:3030/healthz
```

## 非交互式服务器配置

可以复制模板：

```bash
cp config.example.json config.json
```

也可以使用环境变量：

```text
TARGET_URL=https://YOUR-DOMAIN/
PAGE_TITLE=Embedded Site
PORT=3030
ADMIN_USER=admin
ADMIN_PASSWORD=CHANGE-ME
TRUST_PROXY=true
CONFIG_FILE=config.production.json
DATA_DIR=/var/lib/iframe-host
RETENTION_DAYS=30
MAX_RECORDS=10000
```

Nginx 反代时建议传递：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

只有在请求确实经过你控制的反向代理时，才开启 `trust_proxy`。

## 日志

访问日志保存在：

```text
data/access.jsonl
```

实际位置会跟随配置中的 `data_dir` 或环境变量 `DATA_DIR`。

页面会明确提示访问者记录了哪些基础信息。项目不生成浏览器指纹，也不读取联系人、文件或其他本机数据。
