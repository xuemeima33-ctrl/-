# 晴间 · 城市天气

依据 `docs/features/weather-site/prd.md` v1.1 实现的中文天气网站。Node.js 22.11+、原生 HTML/CSS/JS、内置 SQLite；运行时没有第三方 npm 依赖。开发测试使用 Playwright 和 Prettier。

## 本地演示

```sh
npm ci
DEMO_MODE=1 npm start
```

打开 http://127.0.0.1:3000 。可搜索 `北京`、`东京`、`New York`、`Springfield`（同名候选）。**演示模式返回合成天气，页面明确标记，不能当作实时天气。生产模式拒绝开启 DEMO_MODE。**

## 真实天气

```sh
cp .env.example .env
# 将 CITY_SIGNING_SECRET 设置为随机的至少 32 字符值：
# node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# 编辑 .env，设置明确的白名单、IP 限流与上游预算后：
node --env-file=.env --experimental-sqlite src/server.js
```

`.env`、SQLite 数据库和测试产物均已忽略；不要提交凭据。Node 的 SQLite 在最低支持版本中仍属实验功能，因此启动参数必需。

采用 [Open-Meteo 天气接口](https://open-meteo.com/en/docs) 和 [地名接口](https://open-meteo.com/en/docs/geocoding-api)。免费接口无需 API Key，适合非商业演示；商业使用需自行确认套餐与授权。当前天气是供应商模型生成的当前条件，时间直接使用其 `current.time`，不使用请求时间冒充观测时间。地名时区来自供应商 IANA timezone，天气码使用 WMO 中文映射。中文/别名覆盖由供应商决定，1 个字符也提交但供应商可能不返回结果；不保证全球检索覆盖。

可选 `WEATHER_API_KEY` 仅由服务端读取，此时将白名单改为 `customer-geocoding-api.open-meteo.com,customer-api.open-meteo.com`。浏览器始终只访问本站 `/api/*`，不接触第三方凭据。更换 key 后重启实例；泄漏时在供应商撤销旧 key 并轮换。

| 配置                                      | 含义                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| CITY_SIGNING_SECRET                       | 至少 32 字符；所有实例一致；城市候选签名，轮换后需重新选城                 |
| ALLOWED_HOSTS                             | 逗号分隔，必需；免费模式 `geocoding-api.open-meteo.com,api.open-meteo.com` |
| IP_LIMIT / IP_WINDOW_SECONDS              | 每个可信 socket IP 的次数/窗口，正整数且必填                               |
| UPSTREAM_BUDGET / UPSTREAM_WINDOW_SECONDS | 同供应商账号/密钥所有出站尝试的共享预算/窗口，正整数且必填                 |
| DB_PATH                                   | 默认 weather.sqlite；同一部署的全部实例必须指向同一个本地 SQLite 文件      |
| WEATHER_API_KEY                           | 可选付费凭据，仅服务端使用                                                 |
| HOST / PORT                               | 默认 127.0.0.1 / 3000；容器可将 HOST 设置为 0.0.0.0                        |
| NODE_ENV                                  | 正式运行设 production，禁止合成演示数据                                    |

`.env.example` 的阈值是开发示例，**不是批准的生产阈值**。缺少安全配置时真实模式启动失败。生产阈值和账号总额度须与供应商其他调用方合并核算。

## 功能与接口

- 搜索 trim 后 1–100 Unicode 码点；所有候选均显式选择，显示城市、行政区、国家、经纬度；关键字段缺失禁选。候选整体无效、无匹配、全部禁选分别提示。
- 当前温度、体感、状况、湿度、风速，固定 °C、%、m/s；半值远离零，缺字段显示 `--`，保留零值。
- 以可信服务器时间及城市时区计算当地明日起五日，按日历加日，支持 DST；重复日期逐字段合并，冲突字段占位。
- 两模块成功 ready、一失败 partial、都失败 error；字段完整性独立标记。区块重试、手动刷新、切城取消及版本校验阻止旧请求覆盖。
- 当前缓存 10 分钟、预报缓存 60 分钟；命中不续期。当前观测年龄上限 15 分钟（含等号），未来观测失败；页面持续检查并将过期快照标为历史。
- 午夜定时刷新两模块；每秒检查及 visibilitychange/pageshow/focus 恢复检查兜底，每城市每天最多一次自动尝试。失败保留同城旧快照、旧预报实际日期及取数时间。冻结/休眠时无法保证物理五分钟内联网，恢复立即尝试并提示。
- API 每个逻辑请求预算 10 秒，仅网络错误/5xx 最多重试一次，所有尝试共享剩余预算；取消、超时、401/403/429 不自动重试。当前与预报独立请求并共享 reference_at。

`GET /api/search?q=北京` 返回 candidates，选中后将不透明 `city_key` 原样传给 `GET /api/weather?city_key=...`。可附 `module=current` 或 `module=forecast` 独立重试。天气响应含模块 status、completeness、data、reference_at、fetched_at、timezone，当前额外含 updated_at。未知参数、重复参数、非法签名和超范围坐标均拒绝；不支持客户端传 URL/host/经纬度覆盖。

## 安全部署边界

- HTTPS 上游仅允许代码中固定主机+路径与部署白名单的交集；不跟随重定向。每次 DNS 查询验证全部 IPv4 地址，拒绝非公网/保留/元数据地址，再把公网地址固定到 HTTPS 连接，保留主机证书校验以防 DNS 重绑定。IPv6 上游暂不启用。
- IP 取 TCP socket 地址，忽略所有 X-Forwarded-For。直接暴露应用时可分别计数；反向代理部署默认把该代理下所有用户计为同一 IP（保守限流），如需真实客户端 IP，须添加经过安全审查的可信代理/边缘限流配置，不能直接信任任意请求头。
- SQLite `BEGIN IMMEDIATE` 原子保护计数，同一主机多个进程共享同一数据库；缓存同样共享。**不支持各自使用不同数据库的多主机部署，也不支持 NFS SQLite。** 横向跨主机扩容前替换为共享事务数据库/Redis，并补充并发验证；不可用每实例私有 DB 声称共享配额。
- 每次入站先校验和 IP 限流，再查缓存；每次出站（含重试）扣账号配额；达到额度即拒绝。错误脱敏，不输出原始供应商错误或 URL；服务端仅输出启动信息。数据库含短期 IP 哈希计数，窗口过期清理，不记录用户搜索历史。
- 仅四个静态路径可访问，设置 CSP、nosniff、防嵌入与 no-referrer；动态内容以文本或 HTML 转义显示。API no-store，跨域访问未开放。
- 本地开发建议仅监听 loopback；上线需要 TLS、部署负责人、供应商授权/署名审查、生产阈值批准、监控及备份/回滚方案。

## 验证

```sh
npm test
npm run check
npm run test:browser
# 可选代码覆盖率
node --experimental-sqlite --experimental-test-coverage --test test/*.test.js
```

浏览器测试默认使用已安装的 Google Chrome；无 Chrome 环境先安装 Playwright Chromium 并在 `playwright.config.js` 移除 channel，或用自有 CI 浏览器配置。测试服务为合成数据，不消耗第三方额度。测试范围、实际成绩及尚未验证的发布条件见 [verification.md](docs/features/weather-site/verification.md)。

仓库中的 user-research.md 缺失；已依据实际存在的 PRD v1.1 和 prd-review.md 实现，未伪造上游研究材料，未改动 PRD。
