# OrgCompass v2.0.8 开发路线图（补充完善版）

> 状态：候选路线图，版本范围与发布日期待后续确认。
> 目标：在继续扩展组织诊断能力之前，先完成**依赖安全、构建工具链、桌面发布链路**的稳定性收口，并顺带把 HR 用户**最容易误解、最影响信任**的几个低成本点补掉。
> 本文件由团队 v208-roadmap 三视角产出并融合：产品 / 安全·健壮·构建 / HR。
> 详细展开见 companion 文档：产品范围与验收 [v208-product-scope.md](v208-product-scope.md)；安全·构建·CI [v208-security-build.md](v208-security-build.md)；HR 口径审计与价值 [v208-hr-value-audit.md](v208-hr-value-audit.md)。

---

## 0. 定位与范围原则

**v2.0.8 = 「信任与稳定性收口版本」**，不是功能大版本。给用户的一句话承诺：**导入更安全、出错时更清楚、升级后所见不变。**

> **纪律**：v2.0.8 不因“顺手”而膨胀。凡不属于「依赖安全 / 构建稳定 / 发布可靠 / 导入可信 / 诊断可信」的扩展性功能一律推迟。三视角一致同意这个边界。

---

## 1. 范围与优先级（产品 × HR 融合）

### 1.1 做（本版本交付）

| # | 范围 | 归属 | 备注 |
| --- | --- | --- | --- |
| A | xlsx 风险边界 + 输入加固 + 导入校验与错误解释 | 产品 × 安全 | 与 P0 xlsx 处置同批改动，边际成本最低 |
| B | 诊断指标轻量口径说明（面板/报告「怎么算的、不等于什么」） | 产品 × HR | 低配置/文案，防误读 |
| C | 未配置数据呈现修正（未配置编制：黄色“关注” → 灰色“无数据/原因”） | HR | **缺陷修复**：现状与 README「不伪装结论」承诺矛盾 |
| D | 企业阶段情景基准预设（初创/成长/成熟，可切换） | HR | 纯配置 + 切换器，不动数据模型；只做“阶段”，不做“行业” |
| E | 安装 / 升级 / 示例体验对齐 | 产品 | 文档/发布侧，不与 Tailwind/Vite 捆绑 |

### 1.2 推迟（进 v2.0.9 或后续）

| 范围 | 理由 |
| --- | --- |
| 场景差异比较与管理层报告（README Now #2） | 功能扩展，非收口；若 P0/P1 完成后有余量再评估 |
| 行业/企业阶段“诊断基准引擎”（行业维度） | 需跨企业样本标定，先做阶段预设（D），行业留到后续 |
| 招聘缺口与成本视图 | 依赖数据模型梳理 |
| 导入“富字段”（编制/成本/目标职级列）+ 职级差距可达性 | 依赖 xlsx 替换后数据模型扩展 |
| 管理者比剔除兼岗/副职/外部负责人 | 需新数据字段/逻辑 |

### 1.3 明确不做（含边界约定）

- 不新增云端同步 / 遥测 / 账号体系；维持本地优先。
- 不引入在线服务承诺。
- 不新增“黑盒健康评分”：保持 4 项指标可解释、可追溯。
- 不引入用户需重新授权/迁移数据的破坏性变更：`.orgproj` 与导出产物兼容。

### 1.4 优先级（跨视角统一）

| 级别 | 事项 | 本质 |
| --- | --- | --- |
| P0 | xlsx 高危依赖处置 | 技术债收口 + 信任/安全，**第一优先** |
| P1 | Tailwind 4 迁移 | 技术债收口 / 构建回归，独立可回滚 |
| P1 | Vite 8 / React 插件 6 | 技术债收口 / 工具链，独立可回滚 |
| P1 | CI / 发布硬化（PR 门禁 + 依赖审查 + 最小权限） | 发布可靠，**此前最大缺口** |
| P1 | 范围 A、C（导入校验与错误解释；未配置数据呈现修正） | 用户价值 + 信任修复，随 xlsx/现状修正低风险 |
| P1 | 范围 B、D（口径说明；阶段情景基准） | 用户价值（可解释），低成本 |
| P1 | 范围 E（安装/升级/示例对齐） | 用户价值，发布侧 |
| P2 | 范围 V（场景差异/报告、行业基准、招聘视图、富字段导入） | 推 v2.0.9 |

---

## 2. P0 依赖安全：xlsx 处置（已定决策）

跟踪：运行时 `npm audit --omit=dev` 对 `xlsx@0.18.5` 报高危（CVE-2023-30533 / CVE-2024-22363），经 Dependabot alert / 本路线图跟踪；暂未建独立 Issue（如需可新建，用 v2.0.8 P0 归属）。

### 2.1 根因与结论
- `xlsx` 为 SheetJS 社区版，npm registry 最后版本即 **0.18.5**（官方转至 `cdn.sheetjs.com` 分发），故 `npm audit` 报高危且无法用 registry 版本直接修复。
- 命中 **CVE-2023-30533（原型污染，<0.19.3）** 与 **CVE-2024-22363（ReDoS，<0.20.2）**。
- **结论：走官方 CDN 修复线，不必换库。** 直接以 CDN tarball 作为依赖。

### 2.2 推荐（首选）
```json
"dependencies": { "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz" }
```
- 已验证 `cdn.sheetjs.com` 的 `0.20.2` / `0.20.3` 可访问；落地前用官方公告核对最新 security 修复版。
- **无需改代码**（`XLSX.read` / `sheet_to_json` / `json_to_sheet` / `write` 兼容），仅 `package.json` + `package-lock.json` 变更，**单一可回滚**（改回 `^0.18.5` 即回滚）。

### 2.3 备选
- **受控 fork / 再发布**（若必须留在 npm registry）：`@datalens-tech/xlsx`、`weareu/xlsx`、`@e965/xlsx`、`@keep-lts/xlsx`。需评估供应链信任与维护成本。
- **换库 `exceljs`**：官方维护，但不支持旧 `.xls`、API 不同、体积更大，会改 `excel.ts` 与测试，属更大改动，拆独立任务。
- **风险例外**：不建议（修复线存在）；若走例外，必须用户可见、明确披露残余风险并给升级路径，**禁止静默**。

### 2.4 输入加固（必须做，无论选哪条路径）
- 文件大小上限（如 ≤ 10 MB）+ 崩溃兜底；`XLSX.read` 加 `dense: true`、适当 `sheetRows`；不执行公式。
- UI 侧把「解析失败/过大/格式不符」转成可读、可行动、可回退的错误，不裸抛。
- 新增 `excel.security.test.ts`：原型污染载荷、超大/深嵌套/恶意正则、只读预期工作表无副作用。

### 2.5 验收
- [ ] `npm audit --omit=dev` 运行时高危 = 0，且处置决策有记录。
- [ ] 恶意 / 超大 / 异常 workbook 输入安全与健壮性测试全绿。
- [ ] `.xls` 与 `.xlsx` 导入回归通过。

---

## 3. P1 构建稳定性：Tailwind 4 迁移（决策：正式迁移）

关联 Issue：[#9](https://github.com/MaxHou-infinity/orgcompass/issues/9) · PR：[#7](https://github.com/MaxHou-infinity/orgcompass/pull/7)

### 3.1 根因
PR #7 只把 `tailwindcss` 升到 4.3，**未迁移 PostCSS 与 CSS 入口**，导致 `npm run build` 报「Tailwind 4 不再允许直接作为 PostCSS 插件使用」。是**配置不完整**，非库不可用。

### 3.2 步骤
- 装 `tailwindcss@^4 @tailwindcss/postcss postcss`；`postcss.config.js` 改为 `{ '@tailwindcss/postcss': {} }`。
- `src/index.css` 顶部 `@import "tailwindcss";`，删 `@tailwind base/components/utilities;`；`theme.extend` 迁入 `@theme`。
- `tailwind.config.js` 的 `content` 在 v4 自动探测，一般可移除。
- 关键页（健康度面板、部门树、设置面板）视觉回归截图比对。
- `autoprefixer` 是否保留以 build 实测为准（v4 内置 vendoring）。

### 3.3 约束与验收
- **独立、可回滚 commit**，不与 Vite 8 捆绑；配置迁移 + 视觉回归完成前 PR #7 不合并。
- [ ] `npm run build` 通过；[ ] 关键页视觉回归通过；[ ] dev/preview 下 Tailwind 类正常；[ ] 与 Vite 8 解耦、独立冒烟。

---

## 4. P1 工具链：Vite 8 + @vitejs/plugin-react 6

关联 Issue：[#8](https://github.com/MaxHou-infinity/orgcompass/issues/8) · PR：[#4](https://github.com/MaxHou-infinity/orgcompass/pull/4)

### 4.1 前置
- Node 要求 `^20.19.0 || >=22.12.0` → `package.json` 补 `engines`；CI Node 22 满足；`.nvmrc` / README 注明。
- Vite 8 为 Rolldown 驱动：确认 `vite.config.ts` 不依赖被移除 API；检查 `build.target`、`server.port`（tauri `devUrl` 端口 5173）、`base`。

### 4.2 插件
- `@vitejs/plugin-react` 6 移除 Babel 主导路径；本项目为常规 JSX，预期兼容。跑 `lint` + `test` 关注新告警。

### 4.3 Tauri 打包验证（重点）
- macOS aarch64：`npm run tauri:build -- --target aarch64-apple-darwin`；Windows x64：windows runner。
- 确认 `tauri-action` Release 产物（`.dmg/.msi/.exe`）与 `releaseBody` 正常，`frontendDist=dist/` 不变。
- **独立 commit**；打包在升级前后各留验证记录。

### 4.4 验收
- [ ] build/lint/test 通过；[ ] macOS aarch64 + Windows x64 原生打包通过；[ ] `tauri-action` 可追溯验证一次；[ ] `engines` 与 README/CI 一致。

---

## 5. P1 CI / 发布硬化（此前最大缺口）

### 5.1 现状
仅 `.github/workflows/build-tauri.yml`（tag push + workflow_dispatch），**无 PR 触发器、无 build 步骤、无 Rust 缓存**。

### 5.2 新增 PR 专用 CI（`ci.yml`）
- 触发 `pull_request` + `push` 到 `main`；步骤 `npm ci` → `lint` → `test` → `build` → `npm audit --omit=dev`。
- 加 `timeout-minutes`、产物上传、`permissions: contents: read`，并设为**合并必需**（branch protection required status check）。

### 5.3 依赖安全扫描
- `actions/dependency-review-action@v4`（PR 依赖变更审查）+ `npm audit` 门禁；保持 Dependabot security updates 开启。

### 5.4 发布链路硬化
- `permissions` 最小化：`contents: write` 仅 tag 触发时给；`workflow_dispatch` 只读。
- 加 `concurrency`（`group: ${{ github.workflow }}-${{ github.ref }}`、取消进行中）。
- 加 Rust 缓存 `Swatinem/rust-cache@v2`、`fetch-depth`；三级 Action 固定到经审查的 ref/SHA。

### 5.5 一致性
- README 技术栈与最终依赖一致；增补「开发者前置：Node ≥ 20.19」；`SECURITY.md` 增「依赖与供应链安全」小节（说明 CDN 来源与 audit 门禁）。

### 5.6 验收
- [ ] PR 打开触发 `ci.yml` 且为合并必需；[ ] `npm audit --omit=dev` 高危 = 0 过门禁；[ ] 发布 job 仅 tag 写权限；[ ] Tauri 构建有 Rust 缓存。

---

## 6. HR 领域：口径审计、未配置数据呈现修正、阶段情景基准

> 完整审计与值表见 [v208-hr-value-audit.md](v208-hr-value-audit.md)。此处为 v2.0.8 落地摘要。

### 6.1 指出但不在 v2.0.8 修复的口径失真（排 v2.0.9）
- 管理幅度用**平均**被极端值稀释；且“直属员工”取**节点直挂**而非整棵子树，多层组织里中间管理层直管被系统性低估 → 易误报“偏窄/无人直管”。
- 层级深度取**全组织最大路径**，一条深链盖全组织结论。
- 管理者比分母含管理者本人、未剔兼岗/副职/外部负责人。
- 空岗率分子（抽查编制）与分母（全量员工）口径不一致；超编不分战略/冗余。
- 上述**深层次口径修正**需要新数据字段/逻辑，排 v2.0.9；v2.0.8 只做下面的“信任与可解释”收口。

### 6.2 v2.0.8 内落地（低成本，修复信任/可解释）
- **未配置数据呈现修正（核心缺陷）**：`deptStatus` 对 `headcount===null` 返回 `warn`（黄色“关注”），而对应建议是 `info` —— 与 README「不伪装结论」矛盾。改为**灰色“无数据”+ 一句原因**，并补测试。改动牵动 `computeL1` / `computeL3` / `HealthDrawer` 的 StatusDot 呈现，需单独立项。
- **口径说明**：面板每指标一个“?”说明（怎么算、含/不含哪些、不等于什么）；导出的诊断报告附「口径与边界」段。
- **阶段情景基准预设**：只在 `HealthThresholds` 填 3 组值 + 一个切换器（初创/成长/成熟），不动数据模型。参考值：初创 幅度 2–7 / 深度 ≤3 / 管理者比 ≤20% / 空岗率 ≤15%；成长（≈当前默认）幅度 4–8 / 深度 ≤4 / 管理者比 ≤15% / 空岗率 ≤10%；成熟 幅度 5–9 / 深度 4–5 / 管理者比 15–18% / 空岗率 ≤8%。**标注“基准仅供参考，需结合本企业阶段校准”**，可二次微调（现有 `setHealthThresholds` 已持久化）。

### 6.3 文档纪律
- 明确区分「行业模板（组织形态模板）≠ 行业基准（红黄绿阈值）」，避免用户混淆；行业基准留到后续。

---

## 7. 统一出口标准（可量化）

在原有出口标准基础上补充，合并为 v2.0.8 统一验收：

**安全 / 健壮**
- [ ] P0 `npm audit --omit=dev` 运行时高危 = 0，且处置决策有记录。
- [ ] 恶意 / 超大 / 异常 workbook 输入安全与健壮性测试通过（新增 `excel.security.test.ts`）。
- [ ] `.xls` 与 `.xlsx` 导入回归通过。

**构建 / 工具链**
- [ ] `npm ci` / `lint`（无新增错误）/ `test`（全过）/ `build` 通过。
- [ ] Tailwind 4 迁移为独立可回滚 commit，关键页视觉回归通过。
- [ ] Vite 8 / plugin-react 6 为独立 commit，macOS aarch64 + Windows x64 原生打包通过。
- [ ] `package.json` `engines` 与 README / CI 的 Node 版本一致。

**CI / 发布**
- [ ] 新增 PR `ci.yml`（lint/test/build/audit）且为合并必需；依赖审查接入。
- [ ] 发布 job 仅在 tag 上写权限；`contents: read`；Tauri 构建有 Rust 缓存。
- [ ] Release 工作流在目标版本上完成一次可追溯验证。

**产品 / HR（用户可感知）**
- [ ] 导入异常 Excel 给清晰可行动失败提示，不崩溃、可回退；超限/超大工作簿给提示或限额，不卡死。
- [ ] 导入入口出现“本机处理，数据不出设备”微文案（不夸大）。
- [ ] 升级后核心路径一致，关键页视觉零漂移，`.orgproj` 兼容。
- [ ] 未配置编制显示“无数据/原因”（非黄色关注）；超编与空岗分开呈现。
- [ ] 面板/报告能说明 4 项指标“怎么算的、不等于什么”；提供企业阶段情景基准预设。
- [ ] README 技术栈、安装说明与最终依赖版本一致。

---

## 8. 评审 / 合规与回滚原则（全局）

- **每项独立、可回滚、有验证记录**，不把 P0 / P1 捆绑到同一提交。
- xlsx 从 npm registry → CDN tarball，需在 SECURITY / README 记录该**非标准来源**与 CI 校验策略；企业内网无法访问 CDN 时降级为受控 fork。
- 任何路径都**禁止**用「绝对无风险」的过度承诺；风险例外必须用户可见并披露残余风险。
- 仓库当前无 PR 专用 CI；合并前验证不能只依赖 GitHub 的 `MERGEABLE` 状态。

---

## 9. 当前已完成基线 / 关联记录

- Dependabot PR #1、#2、#3 已合并。
- PR #7（Tailwind 4）、PR #4（Vite 8）保持 open，独立问题记录 #9 / #8 已建。
- 仓库门面优化与 `main` 最小 Ruleset 已完成（见 `docs/github-repository-settings-checklist.md`）。
- 直接依赖 `xlsx@0.18.5` 高危，已交由本路线图 P0 处置。

---

## 附：三视角 companion 文档

| 视角 | 文档 | 内容 |
| --- | --- | --- |
| 产品 | [v208-product-scope.md](v208-product-scope.md) | 范围/验收/风险边界/用户话术 |
| 安全·健壮·构建 | [v208-security-build.md](v208-security-build.md) | xlsx 处置/Tailwind 4/Vite 8/CI 硬化明细 |
| HR | [v208-hr-value-audit.md](v208-hr-value-audit.md) | 指标口径审计/阶段基准/HR 价值优先级 |
