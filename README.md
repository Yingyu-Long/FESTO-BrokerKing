# Smartenance 维修任务 CSV 导出

本地英文网页程序：连接 Festo AX Smartenance，选择一台或多台设备及创建日期，预览并导出故障记录下面的维修子任务（Repair tasks）。

## 启动与使用

当前电脑已安装依赖。双击本目录的 **启动维修导出.command**，保留打开的终端窗口。浏览器会打开 <http://localhost:3000>。使用完成后，在终端按 Control+C 停止程序。

也可以在此目录运行：

```sh
npm run dev
```

1. 在页面填写 **Access Token**（可包含 `Bearer ` 前缀），或切换到 **API account**，输入 Smartenance Premium API 账号和密码。
2. 连接后，按设备名称或编号搜索，可多选或全选。
3. 选择维修任务的创建日期范围，点击“Find repair tasks”。
4. 查询完整结束后点击“Export all to CSV”。表格每页预览 20 条，导出包含全部查询结果。

程序不会自动保存账号密码或令牌。令牌只在页面内存中使用；刷新或断开连接后需要重新登录。不要把凭证发到聊天中。请求由本机服务转发到固定的 Festo 官方地址，未配置云服务或数据库。

## 时间和导出语义

- 筛选字段严格为 `repairTasks[].createdAt`，不是故障创建时间、发生时间或修改时间。
- 使用北京时间 `UTC+8`，起止日期包含全天。例如 9 月 1 日至 9 月 8 日等价于 UTC `[8月31日16:00, 9月8日16:00)`。
- 首先完整读取所选设备的故障列表，再读取故障详情的 `repairTasks`。不把日期直接传给故障列表的 `from/to`，避免漏掉较早发生的故障中后来创建的维修任务。
- 无维修子任务的故障不会产生 CSV 行。`Information` / `Maintenance` 日志不作为故障维修子任务导出。
- 维修结果使用 `Unknown / Success / Failure`，显示为“Not recorded / Success / Failure”，不推断任务完成时间。
- 维修子任务没有独立的完成时间。导出中的“故障修复时间”是所属故障的 `fixedDateTime`，不能替代子任务完成时间。
- 结果按维修任务创建时间倒序排列。CSV 有 UTF-8 BOM、英文表头、逗号分隔和 CRLF 行结尾；逗号、双引号和换行按 CSV 规则转义。可能被 Excel 当作公式的文字会加前导单引号。

导出列：设备名称、设备编号、设备 ID、故障编号、故障 ID、故障摘要、故障状态、故障发生时间、故障修复时间、故障描述、故障原因、维修任务 ID、维修任务描述、维修结果、任务创建时间、任务创建人、任务修改时间、任务修改人、任务评论 JSON、任务自定义字段 JSON。所有时间列按北京时间输出。图片和附件本体不下载。

## API 认证

以 [Festo API 规范](https://developers.festo.com/docs/digismartenance-premiumpublicprod/1/overview) 和 [Smartenance 认证说明](https://developers.festo.com/smartenance-authentication) 为依据，核对日期为 2026-09-08。

- API 根地址：`https://api.festo.com/apps/smartenance/v1`
- 使用 `Authorization: Bearer <access_token>`，按需发送 `SMRTNC-LANGUAGE: en`。
- 读取接口：`GET /machines`、`GET /incidents?machineId=...&offset=...&limit=...`、`GET /incidents/{logId}`。
- 故障列表使用文档中的分页字段 `items/count/offset/total`；故障列表单页 200 条，读完所有分页。设备列表使用官方 `limit=-1` 参数读取全部设备，并核对返回总数，不以 200 台为上限。
- 文档对故障列表和详情列出的角色要求不同；账号必须同时具备相应接口权限。普通网页登录账号不一定拥有 Premium API 权限。
- Token 通常有效约一小时。遇到 401 立即停止，不自动用失效令牌重试；403 或 429 显示等待信息，不自动重复请求。
- 官方认证页面的主地址与示例分别列出 `b2c_1_apisignin_ropc` 和 `b2c_1_ropc_apisignin`。账号登录默认使用主地址的前者，在“Trouble signing in?”中可以手动选后者。本程序不会自动轮流尝试密码。已有令牌可直接连接，跳过这个差异。

## 边界和验证

任何设备、分页或详情读取失败，整次查询失败，不允许将部分结果当作完整 CSV 导出。支持主动取消和单请求 30 秒超时。分页总数变化或重复记录会要求重新查询。API 不提供快照一致性承诺；大批量查询时，最好避开持续批量修改的时间段。

设备列表与全选不设 200 / 500 台数量限制。为控制内存，单台最多扫描 100,000 条日志，导出结果最多 100,000 条维修任务；达到限制会明确报错。历史故障较多时，扫描可能较慢，即使选择了较短的任务创建日期范围，也需要读取旧故障以避免漏单。

已用模拟接口测试：跨页读取、旧故障的新维修任务、北京时间边界、中文 CSV、公式转义、401 不重试、权限/限流提示、取消和部分失败。**尚未使用你的真实账号验证数据**；正式使用前建议选一台设备、较短时间范围，与 Smartenance 中的数据核对一次。

```sh
npm test
npm run typecheck
npm run build
```

开发预览和生产本地服务均绑定回环地址，不作为局域网或公网服务使用。构建后可用 `npm start` 运行本地生产服务。移到其他电脑时需 Node.js 22.13+（建议 24 LTS），先执行 `npm ci`。

## 项目结构

- `app/page.tsx`：英文筛选界面、连接、预览和浏览器 CSV 下载。
- `app/api/connect/route.ts`：账号或令牌连接、加载设备。
- `app/api/repairs/route.ts`：查询进度流及完整结果。
- `lib/festo/`：固定地址的 API 客户端、分页、任务筛选、CSV 和请求校验。
- `tests/festo.test.ts`：接口与导出逻辑测试。
- `docs/api-reference.json`：使用到的官方接口与响应字段摘录，便于后续维护。

实现采用 React / TypeScript 与 Vinext，本地请求使用 Node.js 网络环境。此前 Workers 模拟环境在本机访问 api.festo.com 时出现内部连接错误，已切换为 Node.js；开发和生产启动命令均使用本地 Node.js 服务。可选 WebMCP 工具与页面操作共用逻辑，不返回任何认证凭证。

界面、错误提示、CSV 表头和下载文件名使用英文；设备名称和维修内容保持源数据原文。页面左上角与浏览器标签图标使用 `public/brand-icon.png`，原图来自 `assets/tsconfig.json`（实际文件格式为 PNG）。
