# 组织架构设计器 v2.0.1 — 交互与视觉设计规格

> 面向对象：前端设计专家（实现依据）
> 项目：`org-structure-designer-web`（React 18 + TS strict + Vite 6 + Tailwind 3 + Tauri 2）
> 范围：仅交互 + 视觉设计，**不改动 `src/` 代码**（实现由前端设计专家负责）。
> 设计基调：2026 现代 SaaS「液态玻璃 / Aurora 渐变」风格，延续现有 indigo 品牌色并整体升级。

---

## 0. 现状基线（已读代码结论）

| 组件 | 现状 | 本迭代改动点 |
| --- | --- | --- |
| `App.tsx` | 布局 = `Sidebar(w-80)` + `main`(p-6, 渐变背景) + `OrgChart` | 外层加**顶部菜单栏**；zoom 范围 50–150 → **50–200**；接入空状态引导数据源 |
| `Sidebar.tsx` | 左侧面板 w-80 `.glass`；含 文件上传 / 操作(缩放) / 导出 / 创建部门 / 职级颜色 / 使用说明 | 「职级颜色」区入口改为**弹窗**；视觉升级 |
| `OrgChart.tsx` | 空状态为纯文本「暂无组织架构数据」；`transform: scale(zoom/100)` | 空状态升级为**引导 Hero**；新增**滚轮缩放手势** |
| `DepartmentCard.tsx` | 部门卡片，level 底色 indigo/emerald/amber，右键菜单 | 卡片视觉升级 |
| `types/index.ts` | `LEVEL_COLORS`（固定 hex 表）、`LEVEL_LABELS`（静态）为常量 | 改为**可由职级弹窗管理的动态数据源** |
| `utils/excel.ts` | 已实现 `generateSampleEmployeeTemplate()` / `generateSampleOrgTemplate()`（内部 `XLSX.writeFile`） | **工具模板**菜单直接调用；Tauri 端需改走 `saveFile` |
| `utils/tauri.ts` | `saveFile()` 支持浏览器/Tauri 双通道 | 模板下载复用 |

> ⚠️ 实现注意：`generateSampleEmployeeTemplate()` / `generateSampleOrgTemplate()` 直接用 `XLSX.writeFile`（仅浏览器下载，Tauri 桌面端可能不弹「另存为」）。建议前端设计专家新增 `generateSampleEmployeeBytes()` / `generateSampleOrgBytes()`（返回 `Uint8Array`），在浏览器/Tauri 都走现有 `saveFile()`。本规格按此假设编写。

---

## 1. Feature 1 — 顶部菜单栏 +【工具模板】入口

### 1.1 整体布局变更

在现有「Sidebar + 主区」之上，增加一条**全宽横向菜单栏（App Bar / Command Bar）**，横跨整个应用宽度。层级关系：

```
┌──────────────────────────────────────────────────────────────┐
│  顶部菜单栏 (h-14 = 56px, 全宽, glass)                          │
│  [◇ 组织架构设计 v2.0.1]        [工具模板 ▾] [缩放-] 100% [缩放+] │
├────────────┬─────────────────────────────────────────────────┤
│ Sidebar    │  主画布区 (OrgChart, 滚动/缩放/空状态引导)           │
│ (w-80)     │                                                 │
└────────────┴─────────────────────────────────────────────────┘
```

**推荐位置**：顶部菜单栏在 Sidebar 和主区**之上**横贯全宽（而非只放主区顶部），理由：
1. 一级操作入口全局可达，不被左侧面板宽度约束。
2. 与「初次使用引导」常驻可见，天然满足**首次可见可发现**需求。
3. 未来扩展「导入/导出/撤销/帮助」等全局命令有统一落位，无需再挤进侧边栏或画布右键菜单。

> 备选（若前端设计专家认为改外层结构成本高）：在 Sidebar 顶部标题下方插入一行「工具模板 ▾」作为第二层工具条。二者二选一，**本规格按「全宽顶部菜单栏」主方案**编写，备选仅行为映射同 1.4。

### 1.2 菜单栏视觉与间距（落地到 Tailwind）

- 容器：`flex items-center justify-between h-14 px-4 bg-white/70 backdrop-blur-xl border-b border-white/40 shadow-soft z-20`（液态玻璃条）。
- 左侧品牌区：
  - Logo：`<span className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 grid place-items-center text-white">`，内置 lucide `Network` / `Building2` 图标（`w-4 h-4`）。
  - 标题：「组织架构设计」`text-[15px] font-bold text-slate-900 tracking-tight`。
  - 版本徽章：`<span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">v2.0.1</span>`。
- 右侧操作组：`flex items-center gap-3`，放【工具模板】主菜单 + 缩放控件（见 1.5/4 章节）。

### 1.3【工具模板】菜单设计

**触发态（按钮 + 下拉）**：
```
┌─────────────────────────────┐
│ [⬇ 工具模板] ▾  (primary)     │   ← 按钮
└─────────────────────────────┘
        │  click / hover 打开
        ▼
┌─────────────────────────────┐
│  ⬇ 工具模板                  │
│  ─────────────────────────  │
│  🧾 员工信息模板              │   ← 子菜单项
│     含姓名/工号/职级/一级~六级部门   │   ← 灰字说明
│  🏢 组织架构模板              │
│     含部门/级别/负责人列         │
└─────────────────────────────┘
```

- **按钮**：`flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 text-white text-sm font-medium shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all`；右侧 `<ChevronDown className="w-4 h-4" />`。lucide 图标用 `Download` 或 `FileDown`（`w-4 h-4`）。
- **下拉面板**：`absolute right-0 top-full mt-2 w-64 rounded-2xl bg-white/90 backdrop-blur-xl border border-slate-100 shadow-xl p-2 z-50`，入场动画 `animate-fadeInUp`（沿用已有 CSS，时长 150ms，位移 4px 足够）。
- **子菜单项**：`flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-indigo-50 transition-colors cursor-pointer`（整块可点击）。
  - 图标列：`w-9 h-9 rounded-lg grid place-items-center bg-indigo-50 text-indigo-500`（员工模板用 `FileSpreadsheet`，组织架构用 `Building2`）。
  - 主文案：`text-sm font-semibold text-slate-800`。
  - 说明文案：`text-xs text-slate-400 mt-0.5 leading-snug`。

**交互行为**：
| 触发 | 行为 |
| --- | --- |
| 点击按钮 | 展开/收起下拉 |
| 悬停按钮（pointer 设备） | 120ms 延迟后展开（桌面友好） |
| 点击子菜单项 | 触发对应模板下载（见下）+ 关闭下拉 |
| 点击面板外区域 / 按 Esc | 关闭下拉 |
| 键盘：Enter 打开、↑/↓ 移动、Enter 选择、Esc 关闭、焦点困于面板 | a11y 标准 |

**下载行为**：点击「员工信息模板」→ 调用 `generateSampleEmployeeBytes()`；「组织架构模板」→ `generateSampleOrgBytes()`；两文件均经 `saveFile()` 输出。建议文件名：
- `员工信息模板.xlsx`（含首行表头：姓名/工号/职级/一级部门/.../六级部门）
- `组织架构模板.xlsx`（含首行表头：一级部门/.../六级部门/部门级别/部门负责人工号/部门负责人）

下载后弹出 toast：「模板已下载，填好后在左侧「文件上传」上传」。

### 1.4 首次使用可发现性（核心诉求）

组合三层保证「无模板用户知道去哪下载」：

1. **常驻可见**：顶部菜单栏始终显示【工具模板】，不折叠、不放二级收拢。
2. **首次引导徽标**：当 `departments.length === 0`（且无模板文件）时，在【工具模板】按钮右上角加一个小琥珀色圆点 + 文本「新」：
   `<span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-white animate-pulse-slow" />`，第一次下载任一模板后移除。
3. **空状态引导 CTA**（见 Feature 2）：「去【工具模板】下载」按钮打开本下拉，形成闭环。

---

## 2. Feature 2 — 初次使用引导（空状态 Hero）

替换 `OrgChart.tsx` 现有空状态纯文本。仅当 `departments.length === 0` 时渲染。

### 2.1 视觉（落地 Tailwind）

```
┌────────────────────────────────────────────────────────────┐
│                         (主画布居中)                          │
│             ┌────────────────────────────────────┐          │
│             │    ◇ 放大图标 (aurora 渐变浮层)        │          │
│             │                                     │          │
│             │   开始设计您的组织架构                 │          │
│             │   —— 三步完成 ——                     │          │
│             │                                     │          │
│             │  ① 下载模板  去【工具模板】下载         │          │
│             │  ② 填写数据  按模板列填写 Excel         │          │
│             │  ③ 上传文件  左侧「文件上传」上传        │          │
│             │                                     │          │
│             │  [ 去下载模板 ]   [ 载入示例数据 ]      │          │
│             └────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────┘
```

### 2.2 结构与类

外层：`flex items-center justify-center min-h-full p-10` 居中。
面板：`max-w-lg w-full rounded-3xl bg-white/70 backdrop-blur-xl border border-white/60 shadow-soft p-10 text-center animate-fadeInUp`。

- **图标区**：`<div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 grid place-items-center text-indigo-500 mb-6">`，内放 lucide `Network`（`w-8 h-8`）。可加一个淡淡 pulse 环：`before 光斑`。
- **标题**：`text-2xl font-bold text-slate-900 tracking-tight mb-2` 「开始设计您的组织架构」。
- **副标题**：`text-sm text-slate-500 mb-8` 「三步即可在几分钟内生成专业组织架构图」。
- **步骤列表**：竖向，`space-y-4 text-left mb-8`。每条：
  ```
  ① [下载模板]  序号圆点 (w-7 h-7 rounded-full bg-indigo-500 text-white text-sm grid place-items-center) + 标题 text-sm font-semibold text-slate-800 + 说明 text-xs text-slate-500
  ```
  步骤：`① 下载模板 → 去【工具模板】下载「员工信息」「组织架构」模板`；`② 填写数据 → 按模板列填写员工与部门信息`；`③ 上传文件 → 在左侧「文件上传」上传 Excel`。
- **CTA 按钮行**：`flex justify-center gap-3`.
  - 主 CTA「去下载模板」：`px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 text-white font-medium shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all`，点击打开【工具模板】下拉。
  - 次 CTA「载入示例数据」：`px-5 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 hover:shadow-sm transition-all`，点击调用现有 `onLoadTestData`（快速预览）。

### 2.3 交互细节

- 步骤③中的「文件上传」为**可点击高亮词**（`text-indigo-600 hover:underline`），点击定位到侧边栏「文件上传」区（`scrollIntoView`，或仅视觉高亮）。
- 「去下载模板」按钮 亦可直接下载「员工信息模板」（一步直达，减少点击）。推荐：**直接下载员工信息模板**，并在 toast 提示「已下载员工信息模板；如需要也可下载组织架构模板」。
- 关闭条件：一旦 `departments.length > 0`（已上传数据），引导自动消失，切换为正常画布。

---

## 3. Feature 3 — 职级自定义表单（弹窗）

### 3.1 触发入口

- **侧边栏「职级颜色」区**：标题右侧加「管理」按钮（`text-xs text-indigo-600 hover:underline`），或整区标题变为可点击卡片。点击打开职级弹窗。
- **顶部菜单栏**：可选加【职级 ▾】子菜单，便于全局入口。二选一即可，推荐侧边栏入口（语义贴近）。

### 3.2 语法定界（重要）

现有系统职级编码形如 `L1.1` / `E3.1`，拆解为：

| 组成 | 字段 | 示例 |
| --- | --- | --- |
| 职级序列代码 | 英文字母，自动大写 | `L`（管理序列）/ `E`（专家序列） |
| 职级编号 | 整数或一位小数 | `1` / `1.1` / `5` |
| 完整编码 | 代码 + 编号拼接 | `L1.1` |
| 中文标签 | 显示名 | `初级专员` |
| 颜色 | 自动分配 | `#FFCC99` |

**数据模型建议**（前端设计专家据此在后端/本地映射，替代静态 `LEVEL_COLORS`/`LEVEL_LABELS`）：
```ts
interface LevelDef {
  code: string;      // 'L' / 'E'（字母，自动大写）
  number: string;    // '1.1'（规范后的字符串，避免浮点精度）
  label: string;     // '初级专员'
  color: string;     // '#FFCC99'
}
// 派生：fullCode = `${code}${number}`  → 用于 LEVEL_COLORS/LEVEL_LABELS 的 key
```
> 建议用字符串存 `number`（避免 `1.1` 浮点误差），完整编码 `code+number` 作为去重/查找 key。

### 3.3 弹窗布局

```
┌─ 职级管理 ─────────────────────────────── ✕ ┐
│  顶部工具栏:  [＋ 新增职级]      (搜索职级…)   │
│                                              │
│  ┌─ 现有职级列表 ────────────────────────┐    │
│  │ 代码   编号   标签       颜色   操作      │    │
│  │ L      1.1    初级专员   ●      ✏️ 🗑️    │    │
│  │ L      1.2    中级专员   ●      ✏️ 🗑️    │    │
│  │ E      3.1    专家      ●      ✏️ 🗑️    │    │
│  └────────────────────────────────────────┘    │
│                                              │
│  ── 新增/编辑 表单区 ──                       │
│  序列代码 [L   ]   编号 [1.1 ]                 │
│  预览: [ L1.1 ]                               │
│  中文标签 [初级专员]                           │
│  颜色  [● #FFCC99] (自动分配, 可点选)           │
│          [ 保存 ]   [ 取消 ]                  │
└──────────────────────────────────────────────┘
```

### 3.4 弹窗结构与类

- 遮罩：`fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm`。
- 容器：`relative mx-auto mt-24 w-[560px] max-h-[80vh] overflow-hidden rounded-3xl bg-white/95 backdrop-blur-xl shadow-2xl animate-fadeInUp`。
- 头部：`flex items-center justify-between p-5 border-b border-slate-100`；标题 `text-lg font-bold text-slate-900` + 关闭按钮（`p-1.5 rounded-lg hover:bg-slate-100`，lucide `X`，w-4 h-4）。
- 正文：`p-5 space-y-5 overflow-y-auto max-h-[calc(80vh-140px)]`。

**列表（表格）**：`w-full text-sm`；表头 `text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100`；行 `border-b border-slate-50 hover:bg-slate-50/60 transition-colors`。颜色列显示 `w-5 h-5 rounded-md border border-slate-200` 色块。操作列：编辑（lucide `Pencil`）/ 删除（lucide `Trash2`，`text-red-500`），均为图标按钮 `p-2 rounded-lg hover:bg-slate-100`。

**表单区（新增/编辑复用同一表单，new 或 edit 模式）**：
- 字段采用聚焦态 `focus-ring`（沿用 `index.css`）。
- 序列代码：`<input maxLength=2>`，`onChange` 内 `.toUpperCase()` 自动转大写，过滤非字母。
- 编号：`<input inputMode="decimal">`，失焦时规范化显示。
- 标签：`<input>`。
- 颜色：展示色块 + hex 文本 + 「自动」标记；点击色块弹出精简色板（12 色）可覆盖。

### 3.5 校验规则

| 字段 | 规则 | 错误提示（inline, 红色 `text-xs text-error-500`） |
| --- | --- | --- |
| 序列代码 | 必填；1–2 个英文字母（A-Z），自动转大写 | 「请输入英文序列代码（如 L / E）」 |
| 编号 | 必填；整数或一位小数（≥1），`^\d+(\.\d)?$` | 「编号为正整数或一位小数（如 1 / 1.1）」 |
| 中文标签 | 必填；长度 ≤ 20 | 「请输入职级中文标签」/「标签过长」 |
| 完整编码唯一 | `code+number` 不允许与其他记录重复 | 「该职级编码已存在」 |
| 标签唯一 | 中文标签允许重复但给出弱警告 | 「该标签已存在（可保存）」 |

- **实时校验**：输入时即时提示，保存时再全局校验（重复编码）。
- **规范化**：编号存为友好字符串（`1`、`1.1`），去除尾随 `.0`（`1.0` → `1`）、前导 0（`01` → `1`）、逗号/空格。
- **阻止非法字符**：序列代码输入非字母立即过滤；编号仅允许数字与一个小数点。

### 3.6 删除交互

- 点击 🗑️ → `confirm` 弹窗「确定删除职级 L1.1（初级专员）？」。
- 若该职级被 N 名员工引用：追加警告「该职级当前被 N 名员工使用，删除后这些员工将显示为「未定义」」。
- 删除后对应员工色块降级为默认灰 `#CCCCCC`。

### 3.7 颜色自动分配

- **调色板**（12 色，饱和但柔和的 2026 调性，兼顾深色文本可读性）——复用/扩展现有 habit，保证图面一致：
  `#FF9999 #FFCC99 #FFFF99 #CCFF99 #99FF99 #99FFCC #99CCFF #9999FF #CC99FF #FF99CC #FF99FF #99CCCC`
- **分配策略**：基于 `fullCode`（`code+number`）的稳定 hash 取模 12，保证同一职级颜色不随增删/重排序漂移；用户可在色板手动覆盖，覆盖后以用户选择为准。
- 展示：新建行颜色默认走自动分配，色块旁显示「自动」标签；用户点选后显示具体 hex 并可「恢复自动」。

---

## 4. Feature 4 — 2026 视觉总方案 + 滚轮缩放手势

### 4.1 配色方案（hex + Tailwind 建议）

| 用途 | Hex | Tailwind 建议 | 说明 |
| --- | --- | --- | --- |
| 主色 Primary | `#6366F1` | `indigo-500` | 品牌主色，按钮/选中/焦点 |
| 主色-深 | `#4F46E5` | `indigo-600` | hover/按压 |
| 主色-亮 | `#8B5CF6` | `violet-500` | 渐变端点（aurora） |
| 渐变 主按钮 | `#6366F1 → #8B5CF6` | `bg-gradient-to-r from-indigo-500 to-violet-500` | 主 CTA / 主菜单按钮 |
| 成功 | `#10B981` | `emerald-500` | 导出/新增/确认 |
| 警示 | `#F59E0B` | `amber-500` | 首次引导徽标/警告 |
| 危险 | `#EF4444` | `red-500` | 删除 |
| 信息/链接 | `#3B82F6` | `blue-500` | 负责人链接 |
| 背景-底 | `#F8FAFC` | `bg-slate-50` | 全局底色 |
| 背景-主区渐变 | `#F8FAFC → #EEF1F6` | `bg-gradient-to-br from-slate-50 to-slate-100` | 主画布（较现有 `#f8fafc→#e2e8f0` 更舒缓，偏冷中性，加一层极淡 aurora 光斑） |
| 表面-卡片 | `#FFFFFF` | `bg-white` | 卡片/弹窗基底 |
| 玻璃-侧边栏 | `rgba(255,255,255,0.72)` | `.glass`（重定义，见 4.2） | 液态玻璃 |
| 文本-标题 | `#0F172A` | `text-slate-900` | 主标题 |
| 文本-正文 | `#334155` | `text-slate-700` | 正文/卡片标题 |
| 文本-次要 | `#64748B` | `text-slate-500` | 说明/标签 |
| 文本-占位 | `#94A3B8` | `text-slate-400` | placeholder/禁用 |
| 反白 | `#FFFFFF` | `text-white` | 主按钮文字 |
| 边框-常规 | `#E2E8F0` | `border-slate-200` | 输入框/分割线 |
| 边框-玻璃 | `rgba(255,255,255,0.5)` | `border-white/50` | 玻璃面板描边 |

### 4.2 关键设计语言（2026）

**液态玻璃（glassmorphism）** —— 重定义 `.glass`：
```css
.glass {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 8px 32px rgba(31, 38, 135, 0.08);
}
```
较现有（blur 12px / 白 0.7 / 边框 0.3）更强模糊 + 增饱和，贴合「liquid glass」。玻璃用于：顶部菜单栏、侧边栏、弹窗、下拉面板、空状态面板。

**Aurora 渐变**：主 CTA 与品牌区用 `#6366F1 → #8B5CF6` 径向/线性渐变；主画布背景加一层极淡 aurora 光斑（可选）：`radial-gradient(1200px 600px at 20% 0%, rgba(99,102,241,0.06), transparent), radial-gradient(1000px 500px at 80% 100%, rgba(139,92,246,0.05), transparent)`。

**圆角（radius）**：
| 元素 | 圆角 | Tailwind |
| --- | --- | --- |
| 按钮/小控件 | 0.75rem | `rounded-xl` |
| 部门卡片 / 输入容器 | 1rem | `rounded-2xl` |
| 弹窗 / 下拉 / 空状态面板 | 1.5rem | `rounded-3xl` |

**阴影**（分层、带主色轻染，替代生硬黑影）：
```css
--shadow-soft: 0 2px 15px -3px rgba(0,0,0,.07), 0 10px 20px -2px rgba(0,0,0,.04);
--shadow-card: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(99,102,241,.08);
--shadow-lg-tint: 0 12px 30px rgba(99,102,241,.12);
```
可在 `tailwind.config.js` 的 `theme.extend.boxShadow` 注册（`soft`/`card`/`tint`），便于 `shadow-tint` 等类复用。若不想改配置，可用任意值 `shadow-[0_12px_30px_rgba(99,102,241,0.12)]`。

**间距（8px 栅格）**：主区 padding `p-6`；卡片内 `p-4`；区块间距 `space-y-4/5`；按钮内 `px-4 py-2`；输入框内 `px-3 py-2`。

**字体层级**：
| 层级 | class | 用途 |
| --- | --- | --- |
| App 标题 | `text-[15px] font-bold text-slate-900 tracking-tight` | 顶部栏品牌 |
| 区块标题 | `text-sm font-semibold text-slate-700` | 侧边栏/面板分区 |
| 卡片/节点标题 | `text-sm font-bold text-slate-800` | 部门名 |
| 正文/标签 | `text-sm text-slate-600` | 通用 |
| 说明/元信息 | `text-xs text-slate-500` | 灰字说明 |
| 占位/极弱 | `text-xs text-slate-400` | placeholder |
| 反白加粗 | `text-white font-medium` | 主按钮 |

**动效**：轻量、克制（150–300ms）。沿用已有 `animate-fadeInUp`；按钮 `transition-all duration-200`；卡片 hover `-translate-y-1` + `shadow-tint`。

### 4.3 滚轮缩放交互约定（核心）

**主方案（推荐）：直接滚轮 = 缩放**（单画布设计工具直觉，类 Figma/白板画布）。

| 手势 | 行为 |
| --- | --- |
| 鼠标滚轮（直接，悬停画布空白/图表区） | 缩放（以光标为中心） |
| `Ctrl/Cmd + 滚轮` | 同样缩放（兼容桌面习惯；需 `preventDefault` 阻止浏览器整页缩放） |
| `Shift + 滚轮` | 横向平移/滚动 |
| 按住空白画布拖动 | 平移（pan） |
| 顶部栏「- / +」按钮 | 步进缩放（与滚轮同步，见 4.5） |

> 备选（若产品更希望「滚轮=滚动翻页」）：`Ctrl/Cmd+滚轮=缩放`，直接滚轮=纵向滚动。请与产品确认；本规格按**主方案「直接滚轮缩放」**落实。

**缩放范围**：`50% – 200%`（由现有 50–150 扩展，便于查看大型组织细节）。边界 clamp，到顶/到底给轻微阻尼 `scale(1.0)` 反馈。

**灵敏度**：采用**乘法因子**（非加性，两端手感均匀）。每格滚轮（`deltaY` 归一）：`factor = 1 + clamp(0.001 * |deltaY|, 0, 0.15)`；标准滚轮一格约 `deltaY=100` → factor ≈ `1.1` 即每次 ±10%。推荐乘子 `1.08`（≈8%），配合边界 clamp [0.5, 2.0]。`deltaY` 特别小（触控板）也适用连续缩放。

**以光标为中心缩放公式**（保证光标指向的节点位置不动）：
```ts
const scaleOld = zoom / 100;
const newZoom = clamp(zoom * factor, 50, 200);
const scaleNew = newZoom / 100;
// 画布区域用 transform: scale(scale) + transformOrigin:'top left'，故需补偿滚动：
// （offsetX/Y = 光标相对画布左上角；scrollLeft/scrollTop 为当前滚动）
const newScrollLeft = (scrollLeft + offsetX) * (scaleNew / scaleOld) - offsetX;
const newScrollTop  = (scrollTop + offsetY) * (scaleNew / scaleOld) - offsetY;
canvas.scrollLeft = newScrollLeft;
canvas.scrollTop = newScrollTop;
setZoom(newZoom);
```
`onWheel` 需绑定 `{ passive: false }` 并 `e.preventDefault()`。当前 `OrgChart.tsx` 用 `setZoom`（state）+ 外层 `transform: scale(zoom/100)`；前端设计专家在此逻辑上接入即可。

**按钮与滚轮同步**：`handleZoomIn`（`+10`）上限 `200`、`handleZoomOut`（`-10`）下限 `50`；顶部栏放大/缩小按钮复用侧边栏同款 handlers。滚轮与按钮共同驱动同一个 `zoom` state。

**溢出手势取消**：拖拽部门/员工时（`@dnd-kit` `PointerSensor`，`distance:8`）应抑制滚轮缩放与平移，避免拖拽误触。

**辅助反馈**：缩放时在画布左上角显示气泡 `text-xs` 当前缩放百分比（如 `128%`），停止缩放 800ms 后淡出。顶部栏常驻显示百分比。

---

## 5. 落地清单（给前端设计专家）

| # | 事项 | 涉及 | 说明 |
| --- | --- | --- | --- |
| 1 | 顶部菜单栏 | `App.tsx` | 全宽 h-14 玻璃条，含品牌区 + 【工具模板】 + 缩放控件 |
| 2 | 工具模板下拉 | 新组件 / `Sidebar`/`App` | 两项子菜单 → `generateSampleEmployee/ItemBytes` + `saveFile` |
| 3 | 模板字节函数 | `utils/excel.ts` | 新增返回 `Uint8Array` 版本（复用 `XLSX`），走 `saveFile` |
| 4 | 空状态引导 | `OrgChart.tsx` | 替换纯文本为 Hero，含「去下载模板」/「载入示例数据」 |
| 5 | 职级管理弹窗 | 新组件 + `types/index.ts` | 管理 `LEVEL_COLORS`/`LEVEL_LABELS` 动态化；增删改 + 自动配色 |
| 6 | 滚轮缩放 + 范围扩展 | `OrgChart.tsx` / `App.tsx` | `onWheel(passive:false)`、光标居中、50–200、按钮同步 |
| 7 | 2026 视觉升级 | `index.css` / 组件 class | 重定义 `.glass`、新增 `boxShadow` token、渐变/圆角/字体层级 |

> 约束：以上均不涉及改变 `src/` 已有业务逻辑（部门树构建、拖拽、导出等保持不变），仅新增 UI 层与入口 + 将职级数据源改为可管理。

参照文件：`src/App.tsx`、`src/components/Sidebar.tsx`、`src/components/OrgChart.tsx`、`src/components/DepartmentCard.tsx`、`src/types/index.ts`、`src/index.css`、`src/utils/excel.ts`、`src/utils/tauri.ts`。
