> 远端并行提交 `4d9719eecb0497feda42bc44fb83dc939e925fd8` 的 Python/WeatherAPI 实现说明。此方案需要 WeatherAPI 凭据；与默认 Node/Open-Meteo 服务分开启动，禁止混用两套供应商的密钥。以下命令从仓库根目录执行。

# 知晴 · 城市天气

Python 3.9+ 标准库服务端 + 原生 HTML/CSS/JavaScript，无运行时第三方包。依据 `docs/features/weather-site/prd.md` v1.1 实现。提供显式选城、当前五指标、城市当地明日起五日预报、分模块降级与重试、同城历史快照及午夜自动刷新。

## 本地运行

```sh
cp weatherapi.env.example .env.weatherapi
# 编辑 .env.weatherapi，填写密钥、账号、数据库绝对路径和保护阈值
set -a
. ./.env.weatherapi
set +a
python3 -B server.py
```

访问 http://127.0.0.1:8000 。没有配置也可以启动和查看页面；API 将返回脱敏 503。Python 必须具有 IANA 时区数据库（macOS/Linux 系统通常自带；精简镜像需安装系统 tzdata）。不要将密钥用于 `PUBLIC_` 等前端变量，勿提交 `.env` 或数据库。轮换密钥后重启进程并重新搜索城市，旧城市键会失效。

## 天气供应商

适配 [WeatherAPI 官方接口](https://www.weatherapi.com/docs/)：`/v1/search.json`、`/v1/current.json`、`/v1/forecast.json`；服务端使用 `days=6`，过滤掉今天，严格保留 D+1…D+5。需选购支持**至少六个自然日（含今天）**的套餐，不能以免费套餐不足五日冒充完整实现。预报不足会展示失败日期及不全状态。正式接入前用实际账号确认中文/英文检索、目标城市覆盖、观测时间新鲜度、授权、缓存和署名要求；页面已提供 WeatherAPI 署名链接。条件码采用固定中文映射，未知码按缺字段处理，不展示供应商任意文本或图片 URL。

配置：

| 变量                           | 用途                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `WEATHER_API_KEY`              | 只存在于服务端环境的供应商密钥                                           |
| `WEATHER_ACCOUNT`              | 同一供应商账号在全部进程中必须使用相同标识，按账号扣预算                 |
| `WEATHER_ALLOWED_HOSTS`        | 必须显式等于 `api.weatherapi.com`；代码同时固定 HTTPS/443 和三个允许路径 |
| `IP_LIMIT` / `IP_WINDOW`       | 每个 socket 来源 IP 每窗口最多请求次数 / 秒                              |
| `QUOTA_LIMIT` / `QUOTA_WINDOW` | 账号每窗口最多出站次数 / 秒；首次与重试均计数                            |
| `WEATHER_DB`                   | SQLite 数据库绝对路径，父目录必须已存在且可写                            |
| `BIND` / `PORT`                | 默认 `127.0.0.1` / `8000`                                                |

`weatherapi.env.example` 中数值仅供开发示例，**不是批准的生产额度**。缺密钥、白名单、保护配置或无效正整数阈值时失败关闭。

## 行为与安全边界

- 浏览器只请求本站 `/api/search?q=…` 与 `/api/weather?city_key=…&module=all|current|forecast&refresh=0|1`；不接受 URL/host/端口等附加参数。城市键由服务端签名并映射到搜索返回的合法坐标，24 小时失效。
- 所有 API 在读缓存前按来源 IP 限流；不信任 `X-Forwarded-For`。直接部署时逐客户端计数；反向代理部署时会合并为代理 IP 的限流，不能声称逐用户限流。上线若需反代，应配置透明源地址保留，或在受信任入口实施独立共享 IP 限流，禁止直接信任浏览器转发头。
- SQLite `BEGIN IMMEDIATE` 原子共享计数；同机多进程/多实例必须挂载**同一个本地数据库文件**。不支持各实例独立磁盘、网络文件系统或多主机横向扩容；后者部署前须替换为共享原子计数服务。不能复制数据库后声称共享配额。
- 出站 DNS 的全部地址先检查公网性质，再连接解析后的固定地址并按原始域名验证 TLS，防 DNS 重绑定；不跟随重定向，不使用系统 HTTP 代理。响应大小上限 2 MB。网络错误/5xx 最多重试一次；超时、证书/安全错误、401/403/429 不重试。每次搜索/天气逻辑请求共享 10 秒预算，天气两模块并行并共享 reference_at；迟到结果不进入页面或缓存。
- 当前缓存 600 秒，预报缓存 3600 秒，等于 TTL 即失效；命中不续期。当前观测超过 900 秒或任何未来时间均失败。预报每次按城市时区重算日历日期；缓存不全时补取。手动刷新与区块重试绕过对应缓存。
- 页面用独立搜索和区块版本丢弃过时响应；切城清旧快照，同城失败保留标记过期/历史的数据。每秒检查服务端校时后的城市日期，跨当地午夜自动刷新一次；恢复可见和 pageshow 立即检查，失败不无限自动重试。当前快照满 15 分钟后转为过期历史。
- 静态资源固定映射、CSP 限同源、禁止嵌入；不记录访问 URL、原始上游错误或密钥。本实现无需产品历史数据库，仅保留短期安全计数、城市映射和缓存。

开发服务器使用标准库 HTTPServer；公网部署须置于具备 TLS、连接数与请求大小保护的受管入口后，并保持服务端端口私有。部署前负责人需确认生产阈值、套餐及上述共享存储/来源 IP 边界。

## 验证

```sh
python3 -B -m unittest discover -s tests -v
node --check static/app.js
# 可选浏览器测试，需要 Node.js + Playwright + Chromium
# PLAYWRIGHT_MODULE 指向 playwright 包目录，先启动本地 server.py
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/browser.cjs
```

单元/接口夹具覆盖舍入、Unicode 长度、字段缺失、重复日期合并、时区/DST、15 分钟边界、TTL、状态矩阵、参数攻击、共享原子计数、失败关闭及条件重试。浏览器测试以明确标记的模拟 API 验证页面逻辑，不代替供应商验收。

没有真实密钥时不宣称真实供应商接入通过。发布仍须补齐 PRD 指定最近两个主版本的 Chrome/Safari/Edge、iOS/Android 实机矩阵，以及生产同配置、真实上游 50 并发冷/热缓存各 10 分钟且不少于 1000 样本的 P95≤3 秒报告。模拟测试及本机测试不能替代这些发布门槛。
