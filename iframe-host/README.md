# iframe-host

独立的 Node/Express iframe 承载页和访问审计后台，仅用于你自己控制的站点。

## 功能

- 首次运行交互式配置，并保存到 `config.json`
- 后续零参数运行：`npm start`
- 支持用环境变量覆盖配置
- 持久化记录访问时间、IP、User-Agent、来源页和设备摘要
- 管理员后台查看、刷新、弹窗查看详情和清空日志
- 自动按保留天数和最大记录数清理
- `TRUST_PROXY` 默认关闭，避免直接相信伪造的转发 IP

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

页面会明确提示访问者记录了哪些基础信息。项目不生成浏览器指纹，也不读取联系人、文件或其他本机数据。
