# OrgCompass v2.0.8 — 安全 / 健壮 / 构建视角（security-build-expert）

> 作者：security-build-expert（团队 v208-roadmap）
> 定位：本文件只描述 **依赖安全 / 输入健壮性 / 构建工具链 / 发布 CI** 视角。产品 / 用户 / 验收口径以 [v208-product-scope.md](v208-product-scope.md) 为准（尤其 §2 验收标准、§8 对齐要点）；HR 领域价值与诊断口径以 [v208-hr-value-audit.md](v208-hr-value-audit.md) 为准。本文件在结论处与二者对齐。
> 用途：可直接并入 `docs/v208-roadmap.md`，作为 v2.0.8 的安全/构建侧收口。

---

## 0. 一句话结论

v2.0.8 的工程收口要**一次做对、可回滚、有验收**：

- `xlsx@0.18.5` 的高危**有官方修复线**（CDN 0.20.x），不必换库即可命中 CVE-2023-30533（原型污染）+ CVE-2024-22363（ReDoS），这是**首选**；
- 导入链路（前置扩展名/大小/结构校验 + 解析异常可读错误）**与 xlsx 处置同一批改动**，避免二次触碰导入路径（对齐 product §8）；
- Tailwind 4 / Vite 8 + plugin-react 6 对用户**不可见**，但必须**独立、可回滚**，并保留关键页面视觉回归基线（对齐 product §2.4 R2）；
- **CI 是当前最大缺口**（只有一个 tag/dispatch 的 `build-tauri.yml`，无 PR 触发器），需新增 PR CI + 依赖门禁 + 最小权限 + Rust 缓存。

**基线事实（本次实测）**：`package.json` v2.0.7；已安装 `xlsx@0.18.5`、`vite@6.4.1`、`tailwindcss@3.4.19`、`@vitejs/plugin-react@4.7.0`；`package.json` 无 `engines` 字段；CI 仅 `.github/workflows/build-tauri.yml`（`push tags` + `workflow_dispatch`，无 PR 触发器、无 `npm run build` 步、无 Rust 缓存、`permissions: contents: write` 全放开）。攻击面：`src/utils/excel.ts#readFirstSheet` 用 `XLSX.read(data,{type:'array'})` 直接解析用户上传的 `.xlsx/.xls`（`src/components/Sidebar.tsx` `accept=".xlsx,.xls"`），无大小/结构限制。

---

## A. P0 · xlsx 运行时高危依赖：方案对比与决策

### A.1 问题定性（为什么 Dependabot 修不了）

- `xlsx` 是 SheetJS 社区版。**npm registry 上最后发布版本就是 `0.18.5`**，之后官方转移到 `cdn.sheetjs.com` 分发、npm 不再更新，因此 `npm audit` 报高危且 Dependabot 无法用 registry 版本直接升级。
- 两个高危 CVE 都命中本项目「上传即解析」的真实入口：
  - **CVE-2023-30533** 原型污染（Prototype Pollution），`< 0.19.3` 触发，**0.19.3 修复**。
  - **CVE-2024-22363** 正则 DoS（ReDoS），`< 0.20.2` 触发，**0.20.2 修复**。
- 关键点：**npm 上没有修复版本，但官方修复线存在**——可直接以 CDN tarball URL 作为依赖。

### A.2 方案对比（≥3 方案）

| 方案 | 描述 | 优点 | 缺点 / 成本 | 供应链风险 | 推荐度 |
| --- | --- | --- | --- | --- | --- |
| **A. 官方 CDN 修复版**（首选） | `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.x/xlsx-0.20.x.tgz"` | 仍官方维护、同一 API 线；`src/utils/excel.ts` 与 `excel.test.ts`/`excel.integration.test.ts` 的 `XLSX.read`/`sheet_to_json`/`json_to_sheet`/`write` **无需改代码**；仅 `package.json`+`package-lock.json` 变更 | 供应链从 npm registry 变为 CDN tarball；需在 SECURITY/README 记录非标准来源 | 低（官方 CDN） | ⭐ **首选** |
| **B. 受控 fork / 再发布** | `@datalens-tech/xlsx`（社区按 0.20.x 重发布）、`weareu/xlsx`（0.18.5 fork 并双 CVE 修复）、`@e965/xlsx`、`@keep-lts/xlsx` | 回到 npm registry；继承修复 | **非官方发布**，需评估维护活跃度与信任度；版本同步滞后 | 中（第三方） | 备选（CDN 不可达时） |
| **C. 换库 `exceljs`** | 官方维护，可读写 xlsx | 长期维护性最好 | **不支持旧 `.xls` 二进制**；API 不同；体积更大；需改 `excel.ts` 解析/导出逻辑与全部相关测试 | 低 | 不推荐（改动大，除非 A/B 都不可行） |
| **D. 风险例外（不推荐默认）** | 保留 0.18.5 + 输入校验降低暴露面 | 零改动 | **高危残留**；必须用户可见 + 发布说明明确披露，否则最伤信任（对齐 product §6.3） | 高 | 仅当 A/B/C 全不可行才可用 |

### A.3 决策建议（推荐 / 备选 / 回滚）

- **推荐（首选）**：锁定官方 CDN 修复版。原因：①官方维护、同一 API，**代码与测试零改动**；②单一、可回滚（改回 `^0.18.5` 即回滚）；③命中两个高危 CVE。落地前用 `npm view`/官方 CDN 核对确切最新版（当前序列 0.20.3；若官方已发布更高 security-fix 版则用之）。
- **备选**：若目标环境无法访问 `cdn.sheetjs.com`（企业内网/镜像），改用受控 fork（方案 B），并评估维护成本。
- **明确不做默认 D**：存在官方修复线时，v2.0.8 **不走风险例外**。
- **回滚**：A/B 均为依赖项变更，`package-lock.json` 可整包回退；若换 C，回滚需一并还原 `excel.ts` 改动（因此 C 应单独成 commit）。

### A.4 输入加固（任何路径都必须做，属「健壮性」）

- **大小/行数上限**：`readFirstSheet` 目前整文件读入 `ArrayBuffer`，无上限。加**软提醒阈值**（如 >10MB 提示"可能较大，处理可能变慢"）与**硬上限**（如 >50MB 明确拒绝）。
- **解析防护**：`XLSX.read(data,{type:'array'})` 建议加 `dense: true`（规避 Ghost 单元格对象放大）、适当 `sheetRows`（超大表只取前 N 行）；不开启公式计算。
- **异常隔离 + 用户文案**：把「文件过大 / 扩展名不支持 / 缺列 / 首行非表头 / 结构自相矛盾」映射为**可行动、可回退**的错误提示（文案以 product §2.1/§2.2 为准），不裸抛、不生成不可回退的空树。
- **暴露面收敛**：保持 xlsx 懒加载（`import('xlsx')` 仅在上传/导出时按需加载），不进入服务端路径。

### A.5 新增 Vitest 测试清单（恶意 / 超大 / 异常 Excel）

建议新增 `src/utils/excel.security.test.ts`（保留 `excel.test.ts` / `excel.integration.test.ts` 之外的覆盖）：

| # | 用例 | 断言 | 归属 |
| --- | --- | --- | --- |
| SEC-1 | **原型污染**：构造含 `__proto__`/`constructor`/`prototype` 键作为单元格/表名/列头的工作簿 | 解析后 `Object.prototype` 未被污染；返回的行对象不含 tainted key；`Object.prototype.polluted === undefined` | 安全 |
| SEC-2 | **ReDoS / 超大**：构造超大 sheet（大量行/单元格）+ 深嵌套公式 | 解析在超时预算内结束（测试用 timeout 包裹）；超过硬上限时被前置拦截返回错误而非阻塞 | 健壮 |
| SEC-3 | **列缺失**：缺「姓名」/「一级部门」等必填列的员工表 | 抛出带「缺哪几列 + 怎么补齐」的可行动错误，而非裸 `TypeError` | 健壮/可解释 |
| SEC-4 | **空表 / 首行非表头** | 收到指向根因的错误提示；不生成空白组织树 | 健壮 |
| SEC-5 | **结构冲突**：同一部门两个负责人 / 一部门两负责人 | 提示冲突点；不静默取其一 | 可解释 |
| SEC-6 | **扩展名护栏**：`.xls` 可继续、`.csv`/未知扩展名被拒并提示「请另存为 .xlsx」 | 与产品 §3.2 扩展名策略一致 | 输入护栏 |
| SEC-7 | **导入回归一致性（S4）**：同一份标准样例在处置前后导入 | 生成的部门树与员工归属**完全一致** | 回归 |
| SEC-8 | **未配置编制呈现**：`deptStatus(headcount===null)` | 与 HR 修正对齐后返回 **info（无数据）** 而非 warn（黄灯）；对应建议为 info | 口径/健壮 |

> SEC-8 与 HR 指出的「未配置编制显示黄色关注」的不一致直接相关，见本文件 §E（与 HR / 口径的关联项）。

### A.6 可验收出口（P0）

- [ ] `npm audit --omit=dev` 运行时高危项 = 0（CDN 修复版落地后）。
- [ ] `excel.security.test.ts` 全部用例通过（SEC-1..SEC-8）。
- [ ] `.xls` 与 `.xlsx` 两种导入在 v2.0.8 仍可用；CDN 修复版对 `.xls` 的兼容若退化，需在 README 说明或转方案 C。

---

## B. P1 · Tailwind 4 迁移：决策与方案

### B.1 现状与阻塞根因

- 现为 `tailwindcss@3.4.19`，`postcss.config.js` 用 `tailwindcss:{}`（v3 插件方式），`src/index.css` 用 `@tailwind base/components/utilities;`。
- PR #7 把 `tailwindcss` 升到 4.3，但**未迁移 PostCSS 与 CSS 入口**，故 `npm run build` 报「Tailwind 4 不再允许直接作为 PostCSS 插件使用」。**这是配置不完整，不是库不可用。**

### B.2 决策：正式迁移（不退回 v3）

理由：Tailwind 3 已进入维护放缓；本次是顺手收口构建回归。但必须在配置迁移 + 视觉回归完成前**不合并 PR #7**。

### B.3 迁移步骤

- 安装：`npm i -D tailwindcss@^4 @tailwindcss/postcss postcss`。
- `postcss.config.js`（ESM）改为：
  ```js
  export default { plugins: { '@tailwindcss/postcss': {} } }
  ```
- `src/index.css` 顶部改 `@import "tailwindcss";`，删除三行 `@tailwind ...;`；自定义 `theme.extend`（boxShadow/keyframes/animation）迁入 `@theme { ... }`：
  ```css
  @import "tailwindcss";
  @theme {
    --shadow-soft: 0 2px 15px -3px rgba(0,0,0,.07), 0 10px 20px -2px rgba(0,0,0,.04);
    --shadow-card: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(99,102,241,.08);
    --shadow-tint: 0 12px 30px rgba(99,102,241,.12);
    /* slideInRight / slideInUp keyframes + animation 同步迁入 */
  }
  ```
- `tailwind.config.js` 的 `content` 数组在 v4 改为**自动内容探测**，一般可移除；若项目用到特殊 glob 再显式保留。
- **`autoprefixer` 是否仍需保留**：v4 由 Lightning CSS 承担 vendor prefix，通常可移除 `autoprefixer`——**以 build 实测为准**（build 视角验证项）。
- **Node 要求**：Tailwind v4 需 Node ≥ 20（CI 已用 Node 22，满足）。

### B.4 关键页面视觉回归基线（对齐 product §2.4 R2）

- 对以下关键页面做升级前后截图对比，差异为零或为已确认可接受微调：
  - 健康度面板（HealthDrawer）
  - 组织图画布（App.tsx / Department / 部门树）
  - 导入弹窗（Sidebar / OnboardingOverlay）
- 提供一键对比方式（QA），避免人为目测漂移。

### B.5 流程约束与可验收出口

- **独立、可回滚 commit**，不与 Vite 8 捆绑；配置迁移 + 视觉回归完成前 PR #7 不合并。
- [ ] `npm run build` 成功（Tailwind 4 + PostCSS 迁移后）。
- [ ] 关键页面视觉回归通过（无样式回退/丢失）。
- [ ] `npm run dev`/`preview` 下 Tailwind 类正常生效。
- [ ] 与 Vite 8 解耦：Tailwind commit 单独可回滚且独立冒烟通过。

---

## C. P1 · Vite 8 + @vitejs/plugin-react 6：计划

### C.1 前置条件

- **Node 最低版本**：`^20.19.0 || >=22.12.0`（Vite 7+ 已要求，Vite 8 同理）。`package.json` **补 `engines` 字段**：
  ```json
  "engines": { "node": "^20.19.0 || >=22.12.0" }
  ```
  CI `node-version: 22` 满足；README/贡献指南同步注明，避免贡献者用旧 Node。
- **Vite 8 为 Rolldown 驱动**：确认现有 `vite.config.ts`（仅 `plugins:[react()]`）不依赖被移除 API；检查 `server.port`（tauri `devUrl` 是 `http://localhost:5173`，Vite 默认 5173 保持一致）、`base`、`build.target` 未破坏。

### C.2 @vitejs/plugin-react 6

- v6 移除 Babel 主导路径（趋向 swc/oxc）；本项目 `App.tsx`/components 为常规 JSX、无自定义 babel transform，**预期兼容**。升级后跑 `npm run lint` + `npm run test`，关注 react-refresh / react-hooks 规则是否有新告警。
- 若遇不兼容，回退到 `@vitejs/plugin-react-swc` 或保留 v4 并记录原因。

### C.3 Tauri 打包验证（本视角重点）

- `src-tauri/tauri.conf.json`：`beforeBuildCommand: "npm run build"`（即 Vite build）。Vite 8 升级后**必须**重验：
  - **macOS Apple Silicon（aarch64-apple-darwin）**：`npm run tauri:build -- --target aarch64-apple-darwin`
  - **Windows x64**：windows runner 构建
  - 确认 `tauri-action` Release 工作流产物命名与 `releaseBody` 正常（`.dmg/.msi/.exe` 不因 bundle 输出变化而丢失）。
- **前端/桌面版本匹配**：Tauri 2.11.3（Rust）、`@tauri-apps/cli` 2.11.4、`@tauri-apps/api` 2.11.1 —— 与 Vite 8 无直接耦合；确认 Vite 8 输出目录仍是 `dist/`（是）。
- **回滚**：Vite/plugin-react 升级单独 commit，`package-lock.json` 整包回退；打包在升级前后各留一次验证记录。

### C.4 可验收出口

- [ ] Web `npm run build` 成功（Vite 8 + plugin-react 6）。
- [ ] macOS aarch64 原生打包成功产出 `.dmg`。
- [ ] Windows x64 原生打包成功。
- [ ] `tauri-action` Release 工作流在目标版本触发一次**可追溯验证**（真实 tag，非手动 only）。
- [ ] `package.json` `engines` 与 README / CI 的 Node 版本一致。

---

## D. P1/P2 · CI 与安全硬化（当前最大缺口）

现状确认：**只有一个 `build-tauri.yml`**，仅 `push tags` 与 `workflow_dispatch` 触发；无 PR 触发器；无 `npm run build`；无 Rust 缓存；`permissions: contents: write` 对所有触发无条件放开；无 `concurrency`、无 `timeout-minutes`、无失败产物留存。这正是 roadmap「仓库当前没有 PR 专用 CI 检查」的缺口。

### D.1 新增 PR / 分支 CI（`ci.yml`）

- 触发：`on: pull_request:` 与 `push: branches: [main]`。
- Jobs（每项独立 job，便于定位）：
  1. `lint`：`npm ci && npm run lint`
  2. `test`：`npm ci && npm run test`
  3. `build`：`npm ci && npm run build`
  4. `audit`：`npm audit --omit=dev --audit-level=high`（运行时高危=0 门禁；xlsx 修复版落地后可过；若想全树可加 `npm audit --audit-level=moderate`，需权衡误报）
- 每个 job 加 `timeout-minutes`（建议 15–30）；失败时 `actions/upload-artifact` 上传 `dist/`/构建日志。
- `permissions: contents: read`（CI 无需写权限）。

### D.2 依赖安全扫描

- 引入 `actions/dependency-review-action@v4`（PR 时对依赖变更审查）+ `npm audit` 门禁，与 `SECURITY.md` 私密漏洞报告策略一致。
- 保持 Dependabot `security` updates 开启，为直接依赖提供自动化降级/升级入口。

### D.3 发布链路硬化（`build-tauri.yml`）

- `permissions` 最小化：`contents: write` 仅在 tag 触发时给；普通 `workflow_dispatch` 只读（用 `jobs.<id>.permissions` 或拆分 release job）。
- 加 `concurrency`：`group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true`。
- 加 **Rust 缓存**：`Swatinem/rust-cache@v2`（当前 Tauri 构建无缓存，重复编译/下载慢）。
- 加 `fetch-depth`（避免浅克隆影响 `tauri-action` 版本推断）。
- 三级 Action 固定到**经审查的版本 ref / 提交 SHA**（`actions/checkout@v4`、`actions/setup-node@v4`、`dtolnay/rust-toolchain@stable`、`tauri-apps/tauri-action@v0`），至少加注释说明，防供应链漂移。

### D.4 一致性

- README「技术与质量」与最终依赖（vite/tailwind/plugin-react/xlsx）保持一致；README 增补「开发者前置：Node ≥ 20.19」。
- `SECURITY.md` 可选新增「依赖与供应链安全」小节，说明 CDN tarball 来源与 `npm audit` 门禁。

### D.5 可验收出口

- [ ] PR 打开即触发 `ci.yml`（lint/test/build/audit），且为**合并必需**（branch protection required status check）。
- [ ] `npm audit --omit=dev` 高危=0 通过门禁。
- [ ] 发布 job 仅在 tag 上写权限；CI 全程 `contents: read`。
- [ ] Tauri 构建有 Rust 缓存，重复构建显著加速。

---

## E. 与 HR / 口径的关联项（输入健壮化 / 口径对齐）

HR 视角在 `v208-hr-value-audit.md` 中指出两处与「输入健壮性 / 口径一致性」直接相关的工程问题，请作为**关联项**一并处理：

1. **`deptStatus` 对 `headcount===null` 返回 `warn`（黄灯），但对应诊断建议是 `info`**（analytics.ts L314 vs L746-755）。这是**现状偏离 README「不把缺失数据伪装成健康结论」**的行为不一致：未配置编制的部门被显示为黄色「关注」→ 会被误读为「有问题」。修正：未配置 → 返回 **info / 灰「无数据」+ 一句话原因**。**会牵动 `computeL1`/`computeL3`/`HealthDrawer` 的 StatusDot 呈现与相关单测，建议 v2.0.8 内单独立项、附测试**（对应本文件 §A.5 SEC-8）。—— 归入「口径一致 / 输入健壮化」关联项。
2. **空岗率分子分母口径不一致**（analytics.ts L421-441）：编制只累加 `headcount>0` 的部门，员工数却取全量（含未配置编制部门的员工）→ 在存在大量未配编部门时会**压低空岗率**。修正：空岗率分母只取「已配置编制部门的员工」，与编制口径对齐。—— 归入「输入健壮化 / 口径一致」关联项，建议与 SEC-8 同批处理（均属「未配置数据」的处理，改动集中在 analytics + 测试）。

> 这两处虽属「诊断口径」，但都源于「数据未配置/缺失」这一输入健壮性场景，与 xlsx 处置后的「导入字段校验」同属「把数据讲清楚」的诉求。v2.0.8 若纳入，按**低风险、可回滚**的前端调整 + 附带测试处理，不与 xlsx 替换、不动数据模型。

---

## F. 出口标准增补（在既有 10 项之外补充/明确）

- [ ] `npm audit --omit=dev` 高危 = 0，且处置路径有形成记录的决策（见 §A.3）。
- [ ] `excel.security.test.ts`（SEC-1..SEC-8）全部通过（§A.5）。
- [ ] `.xls` 与 `.xlsx` 导入回归通过（§A.6）。
- [ ] Tailwind 4 迁移为**独立可回滚** commit，且关键页面视觉回归通过（§B.4）。
- [ ] `package.json` `engines` 与 README/CI 的 Node 版本一致（§C.1）。
- [ ] Vite 8 / plugin-react 6 为**独立** commit，macOS + Windows 原生打包通过（§C.3）。
- [ ] 新增 PR CI（lint/test/build/audit）+ 依赖审查 + Rust 缓存 + 最小权限（§D）。
- [ ] 若纳入 HR 关联项：未配置编制呈现修正（warn→info/无数据）+ 空岗率口径对齐，且有配套测试（§E）。

---

## G. 风险与回滚

- **xlsx**：切 CDN tarball 属可回滚单点变更；若企业网络无法访问 `cdn.sheetjs.com`，降级为受控 fork（B），或作为风险例外（D，不建议）。回滚=改回 `^0.18.5`。
- **Tailwind 4**：最大风险是样式回退 → 视觉回归 + 独立 commit 缓解；`autoprefixer` 是否保留以 build 实测为准。
- **Vite 8**：跨大版本工具链 → 独立 commit + 原生打包验证；在打包验证完成前不合并 PR #4。
- **所有升级**：坚持「每项独立、可回滚、有验证记录」，不把 P0/P1 捆绑到同一个 commit / MIRP（对齐 product §6.5 纪律）。
