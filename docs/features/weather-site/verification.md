# 编码验证记录

执行日期：2026-10-16。基线：PRD v1.1，原提交 `2ed3901554d0037e7080e098562b0e369f515329`。此次按任务授权直接编码，没有等待技术计划；原 PRD 和质检报告保持原样，user-research.md 在仓库中缺失。

## 已执行

- `npm test`：27 项单元/HTTP 集成测试通过，0 failures。含 M01–M13 字段及模块矩阵、Unicode、舍入、TTL、新鲜度/未来时间、缺字段、重复日期、DST、错误结构/全禁选、参数绕过、签名校验、DNS 私网/混合解析拒绝且不建 socket、公网固定连接、禁止重定向、10 秒预算机制（注入缩短预算）、条件重试、伪造 XFF、共享 SQLite 计数、并发额度拒绝、密钥仅在服务端传输。
- `npm run test:browser`：9 项真实 Chrome 浏览器测试通过，0 failures。覆盖 320/375/768/1440px 全流程及横向溢出检查、同名候选显式选择、A→B 旧请求隔离、刷新失败保留历史并独立重试、当地午夜自动刷新且只触发一次、超过 15 分钟降级。M14 的错误终态/历史快照由浏览器失败刷新用例覆盖；不声称已覆盖所有后台与断网组合。
- `npm run check`：Node 语法检查与 Prettier 格式检查通过。
- Node 覆盖率（单元/接口测试，不含浏览器 app.js）：`weather.js` 行覆盖率 100%，`security.js` 98.19%，`server.js` 86.30%，`public/state.js` 100%。全报告含测试文件的行覆盖率 96.01%，该数字不作为前端 app.js 覆盖率。原生 HTTPS 真实路径另做下述联调。
- 真实 Open-Meteo 联调：`Beijing` 搜索 HTTP 200，20 项候选；选择北京后 HTTP 200 / ready，current 与 forecast 均 success，日期为 `2026-10-17` 至 `2026-10-21`，对应查询时刻北京当地明日起五日。没有使用真实付费密钥。
- 已人工查看 1440px 与 375px 页面截图，内容布局正常。浏览器测试使用合成数据，页面标明演示数据；真实联调使用真实供应商。

## 发布前仍需验证/确认

这是一份可运行且完成自动测试的编码交付，不代表 PRD 全部发布门禁已通过。

1. PRD 指定的真实供应商、同生产环境 20 城市、50 并发、预热/正式采样、冷/热缓存分别 P95≤3s 的完整负载基准未执行；单次真实联调不能证明该指标。
2. Safari/Edge/iOS Safari/Android Chrome 最近两个主版本、触屏及 200% 浏览器缩放的完整矩阵未执行；已有桌面 Chrome 不等于跨浏览器验证。
3. 供应商商业使用授权、中文/别名覆盖、当前模型时间契约认可、生产阈值、白名单与部署负责人需在发布前冻结。免费 Open-Meteo 不能被默认理解为任意商业使用授权。
4. 当前多实例方案限同一主机/共享本地 SQLite 文件；跨主机需真正共享的事务存储。代理后 IP 默认按代理 socket 保守计数，未启用信任任意 XFF 的逻辑。详见 README。
5. 真实付费密钥的完整 HAR/产物扫描、真实 401/403/429/5xx、所有平台休眠/后台恢复故障矩阵及运维轮换演练仍需部署环境执行；已有脱敏哨兵与故障注入测试不能代替这些验证。

## 复现

Node.js v22.11.0；macOS 15.7.9；Google Chrome 155.0.8059.80。

```sh
npm ci
npm test
npm run check
npm run test:browser
DEMO_MODE=1 npm start
```

真实模式使用 `.env.example` 填入服务端配置，再运行 `node --env-file=.env --experimental-sqlite src/server.js`。演示模式不调用上游，真实模式缺安全配置则拒绝启动。

## 远端并行改动整合

首次推送发现远端新增 `4d9719eecb0497feda42bc44fb83dc939e925fd8`（Python/WeatherAPI）。已保留其代码与历史并合并；根 README 默认说明 Node/Open-Meteo，Python 使用独立的 `weatherapi.env.example` 和 weatherapi-backend.md，避免混用供应商凭据。合并后运行 `python3 -B -m unittest discover -s tests -v`：26/26 通过；Node 27/27 与语法/格式检查再次通过。原有 Python 浏览器脚本未额外执行，本次 Node 的 9 项 Chrome 浏览器测试成绩见上文。
