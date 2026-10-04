# 邮戳与实寄封编目台（gbpostmark）

面向邮品收藏者与邮政史研究者：为邮戳、邮路和实寄封建编目，记录戳型、使用年代、邮路节点与封上票戳组合，并以时间轴还原一封邮件的实际寄递过程。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21824>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21824 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`postmarkStore` / `coverStore` / `routeStore` / `rateStore` / `verifyStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地数据 | IndexedDB（Dexie，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Postmark 邮戳 | `frontend/src/types/postmark.ts` | 编目号、戳型、局所、省份、使用年代、戳面日期、墨色、戳径、戳面文字、中英双文字、稀见度、戳样图、备注 |
| Cover 实寄封 | `frontend/src/types/cover.ts` | 封号、寄出/收件地、寄出/到达日期、贴票构成、关联邮戳、邮路、中转地、给据、品相、来源、购入价、藏册页位 |
| PostalRoute 邮路 | `frontend/src/types/route.ts` | 邮路号、名称、时期、运输方式、节点数组（局所/到达日期/中转戳）、全程天数、班期、备注 |
| StamplessEntry 票戳组合 | `frontend/src/types/stampentry.ts` | 所属封、邮票名称、面值、发行年份、齿度、变体、封上位置 |
| RateRule 资费规则 | `frontend/src/types/rate.ts` | 规则号、资费期、生效/止用日、适用地区、给据适用范围、资费与单位、来源批次、状态（在效/待选定/归档/作废）、冲突对象 |
| RateBatch 导入批次 | `frontend/src/types/rate.ts` | 批次号、来源、状态（导入中/已导入/失败/已中断回滚）、行数统计、错误、清单原文、尝试次数 |
| CoverVerification 核验结论 | `frontend/src/types/rate.ts` | 所属封、结论（相符/欠资/溢付/待复核/无适用资费/日期待考）、适用规则、应贴/实贴/差额、封事实指纹、清单版本 |

另有 `frontend/src/types/asset.ts`：戳样与封的正反面原图在 IndexedDB 中**单独建表**（`assets`）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 重定向到 `/postmarks` | — |
| `/postmarks` | 邮戳目录（按戳型、局所、年代区间筛选，图片墙 ↔ 列表切换） | Postmark |
| `/covers` | 实寄封目录（按收寄地、年代、品相、是否给据筛选，行内显示贴票枚数与关联邮戳数） | Cover |
| `/covers/:id` | 实寄封详情（正反面图、票戳组合表、寄递事实时间轴、欠资核验） | Cover、StamplessEntry、PostalRoute、CoverVerification |
| `/rates` | 资费清单与欠资核验（清单导入、冲突对账池、逐封汇总、批次重试） | RateRule、RateBatch、CoverVerification |
| `/routes/:id` | 邮路编辑器（节点拖拽排序、增删中转地、按节点日期自动算全程天数） | PostalRoute |
| `/search` | 综合检索（跨三类按关键词与年代分组检索） | Postmark、Cover、PostalRoute |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `StampCard.vue`、`CoverCard.vue`、`RouteTimeline.vue`、`ScarceTag.vue`
- hooks：`frontend/src/hooks/useCatalogFilter.ts`（统一过滤与排序）、`frontend/src/hooks/useCoverRoute.ts`（寄递时间轴与在途天数）
- utils：`frontend/src/utils/db.ts`（Dexie 封装/版本迁移/样例数据）、`frontend/src/utils/dateRange.ts`（年代区间、干支互转、日期先后校验）、`frontend/src/utils/id.ts`（编目号与唯一键）、`frontend/src/utils/draft.ts`（localStorage 草稿）、`frontend/src/utils/rateMatch.ts`（资费匹配、冲突判定、逐封核验、清单文本解析）

## 五之一、欠资核验流程

- **接住清单**：`/rates` 页粘贴或读取研究会送来的资费清单（JSON 数组或带表头 CSV），整批导入；任一行校验失败则整批回滚、清单保持原样，批次留原文可「修正重试」；导入中断的批次在下次打开时自动标记「已中断回滚」。
- **选定当期资费**：按寄出日期（落在生效区间内）、收件地（适用地区覆盖）、给据状态选出在效规则，生效日晚者优先。
- **冲突对账**：同一日期区间收到两套互异规则时，冲突行进入「待选定」对账池，选定前不写入在效清单；落在重叠区间的实寄封自动列为「待复核」，对账池卡片上可直接跳转到这些封。
- **失效重算**：贴票构成、寄出日期、收件地、给据或资费清单一改，逐封结论与目录汇总立即失效重算（结论按封事实指纹 + 清单版本落盘留痕）。
- **核验比对**：贴票合计（面值 × 枚数）与应贴资费比对，得出相符 / 欠资 / 溢付，实寄封目录与详情页同步展示。

## 六、本地开发（可选，需要本机 Node 20+）

```bash
cd frontend
npm install
npm run dev          # http://localhost:21824
npm run build        # vue-tsc 类型检查 + vite 构建
```

## 七、目录结构

```
sologsb-1124/
├── docker-compose.yml
├── .env.example / .env
├── README.md
└── frontend/
    ├── Dockerfile          # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/          # postmark / cover / route / stampentry / asset / rate
        ├── stores/         # postmarkStore / coverStore / routeStore / rateStore / verifyStore
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        ├── styles/
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- **编目数据**：IndexedDB（Dexie，库名 `gbpostmark`）。表结构含版本号，`version(2)` 会把戳样与封图迁移到独立的 `assets` 表并补齐历史记录缺省字段；`version(3)` 新增 `rateRules` / `rateBatches` / `verifications` 三张表（资费规则、导入批次、核验结论）；首次运行写入样例数据，便于直接查看各页面效果。
- **表单草稿**：localStorage，键名前缀 `gbpostmark:draft:`（邮戳、实寄封、邮路各一份），刷新或误关页面后可恢复，可一键清除。
- **无后端**：不请求任何外部接口，容器无状态，不使用数据库服务与命名卷；清除浏览器站点数据即等于清空数据。
