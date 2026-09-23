# 组织架构设计器 v2.0.3 — 交互与视觉设计规格（UX 输出）

> 面向对象：前端设计专家（实现依据）
> 项目：`org-structure-designer-web`（React 18 + TS strict + Vite 6 + Tailwind 3 + Tauri 2）
> 范围：仅交互 + 视觉设计，**不改动 `src/` 代码**（实现由前端设计专家负责）。
> 设计基调：完全延续 v2.0.1/v2.0.2 的 2026 现代 SaaS「液态玻璃 / Aurora 渐变」语言（indigo 主色 + emerald/amber/red 状态色），本迭代为**画布交互升级（P0）+ 决策层深化（P1）+ 体验增强（P2）**。
> 版本目标：v2.0.3 = P0 批量选择/移动 + Ctrl+F 搜索 + P1 健康度建议/行业模板 + P2 新手引导打磨。
> 前置：已通读 `docs/design/v201-design.md`、`docs/design/v202-design.md` 及 `src/` 关键组件。

---

## 0. 现状基线（已读代码结论）

### 0.1 与本次相关的现状

| 组件 | 现状（v2.0.2, package.json version=2.0.2） |
| --- | --- |
| `OrgChart.tsx` | dnd-kit `DndContext` + `PointerSensor(distance:8)`；`DragOverlay` 显示单卡拖拽预览（部门卡 / 员工标签）；画布 `transform: scale(zoom/100)`；空状态 `EmptyStateHero`（三步引导：下载模板→填写数据→上传文件）；滚轮缩放（50–200，光标居中）。部门拖拽数据 `data={ type:'department', department }`，员工拖拽 `data: employee` |
| `DepartmentCard.tsx` | 部门卡 `useDraggable(id='dept-drag-{id}')` + `useDroppable(id='dept-{id}')`；头部/负责人/成员列表；右键菜单（调整层级/创建虚拟员工）；**尚无选中态、无批量选中、无搜索高亮** |
| `TopBar.tsx` | 左区：品牌 + 项目名 + 场景切换 + `工具模板▾`（下载两类 Excel 模板）+ 保存指示；右区：`健康度` + 缩放 + `撤销/重做` + `职级管理` |
| `Sidebar.tsx` | 文件上传 / 操作(缩放) / 导出(PNG/Excel) / 分析&备份(健康度/诊断报告/.orgproj) / 创建部门 / 职级颜色 / 使用说明 |
| `HealthDrawer.tsx` | 右侧抽屉 w-[640px]；L1 部门概览 + L2 指标 + L3 编制vs实际vs缺口；已实现 `focusDeptId`（L1 卡点击→聚焦单部门，顶部出现「查看全公司」） |
| `types/index.ts` | `Department` 含 `headcount?`；`LevelConfig` 含 `cost?`；`Employee` 含 `cost?`；`Scenario` 含 `departments/levelConfigs/canvas` |
| `utils/analytics.ts` | `computeHealthReport(depts, configs, focusDeptId?)` → `{ l1, l2, summary, l3, totals }`；`HealthStatus='healthy'|'warn'|'danger'`；L2 指标已含 `verdict` 一句话判读 |
| `utils/statusUI.ts` | `STATUS_STYLE: { healthy/warn/danger }` 提供 `dot/text/bg/border` 视觉类 |
| `index.css` | 已有 `.glass`、`.shadow-soft/card/tint`、`slideInRight/fadeInUp` 动画；`@media print`、`focus-ring` |

### 0.2 需要新增/调整的数据与组件级状态（前端设计专家落地）

| 新增 | 说明 |
| --- | --- |
| **画布选中态** | `OrgChart` 新增 `selectedDepts: Set<string>` + `selectedEmployees: Set<string>`，向下传 `selected`、`onToggleSelect`、`onSelectBatch`；提供一个 `selectionContext`（或直接 prop 透传） |
| **框选状态** | `OrgChart` 新增 `marquee: {x1,y1,x2,y2} | null` + `isMarqueeActive` |
| **搜索状态** | `OrgChart`（或 `main` 层）新增 `searchQuery: string` + 全局命中集 `searchHits: Set<string>`（命中部门/员工 id） |
| **引导状态** | `App`/`OrgChart` 新增 `onboarding: boolean`（首次 localStorage 标记 `org_designer_onboarding_v1`） |
| **行业模板数据** | 新增 `utils/templates.ts`（或 `utils/industryTemplates.ts`）定义 `IndustryTemplate[]`，每个含 `id/name/desc/thumbnail/departments/levelConfigs` |

---

## 1. Feature P0-A — 批量选择 + 批量移动（画布交互升级）

> 目标：让用户能在画布上像 Figma/白板一样**框选多张部门卡/员工标签**，然后**整体拖动**或**批量删除**。是 P0 最高优先级。

### 1.1 交互总览（三种触发方式 + 冲突规避）

| 方式 | 触发 | 行为 |
| --- | --- | --- |
| **框选（marquee）** | 在**画布空白区**按住左键拖出矩形 | 选中与矩形**相交**的部门卡 / 员工标签 |
| **逐点单选** | 单击某部门卡 / 员工标签 | 取消其他选中，仅选中该项 |
| **追加/减选** | `Shift/Cmd + 单击` | 切换该项选中态（不影响已有选中） |
| **清空** | 点击空白 / 按 `Esc` / 点浮动条「撤销选择」 | 清空当前选中集 |

**冲突规避（关键，沿用 v202 §3.2 的启动区域区分）**：

- 现有部门卡 / 员工标签的拖拽由 dnd-kit `PointerSensor` 在**卡片本体内**启动（`distance:8`）。
- 框选在**画布空白区**启动（`onPointerDown` 判断 `e.target` 命中画布背景而非任何 drag source/droppable，即 `!(e.target as HTMLElement).closest('[data-dnd]')`）。
- 二者通过**启动区域**天然互不干扰；框选矩形自身 `pointer-events-none`，不遮挡下层拖拽。

> 实现提示：给每个可拖拽节点（部门卡、员工标签）设一个 `data-selectable` 属性；画布回调用 `e.target.closest('[data-selectable]')` 判断是否落在可选中对象上。命中则启动逐点/追加，未命中则启动框选。

### 1.2 框选（Marquee）视觉与交互

**触发后行为流**：
```
[press 空白区 + 拖动]
      ▼
  出现矩形选择框（半透明填充 + 虚线边框，面板随光标实时更新）
      ▼
  每帧对「候选选中对象」做相交测试 → 命中则高亮（进入 selection）
      ▼
  [release]  结束框选，矩形消失，进入「已选中 N」状态 → 显示浮动工具条
```

**矩形选择框样式（`marquee`）**：

| 属性 | 设计 | Tailwind |
| --- | --- | --- |
| 填充 | indigo 半透明淡染 | `bg-indigo-500/12` |
| 边框 | 品牌主色，带轻微发光 | `border-2 border-indigo-400`（或 `border-solid`） |
| 圆角 | 微圆角贴合玻璃语言 | `rounded-lg` |
| 阴影 | 主色轻晕 + 无阻挡 | `shadow-[0_0_0_1px_rgba(99,102,241,0.1),0_8px_24px_rgba(99,102,241,0.15)]` |
| 交互 | 纯视觉层，不接收事件（避免遮挡下层拖拽） | `pointer-events-none absolute z-[60]` |

> 组件命名建议：`<div className="absolute rounded-lg border-2 border-indigo-400 bg-indigo-500/12 pointer-events-none" style={{ left, top, width, height }} />`。`left/top/width/height` 由 `marquee` 状态（以画布未缩放坐标基准换算，或直接用浮动定位在 wrapper 内）。
>
> **坐标基准**：画布内容是 `transform: scale(zoom/100)` 包裹的。框选的矩形应绘制在**外层未被缩放的 wrapper** 上，用「光标相对 wrapper 的 offset / scale」换算，保证矩形始终贴合光标（参考 v202 §5.1 的以光标为中心思路）。前端实现时统一在此 wrapper 上渲染框选层。

**候选对象相交测试**：对每张部门卡（`data-selectable`）与每个员工标签，取其 `getBoundingClientRect()`，与矩形做 `intersect`；命中即加入选中集。因为矩形在未缩放 wrapper 上，而卡片在缩放层内，需用**视觉坐标**（rect 归一为视口坐标）判断相交，避免缩放误差。

### 1.3 选中态视觉

**部门卡多选高亮**：
```
┌──────────────────────────────┐
│  (卡片)   →  外描边 + 淡光晕 + 轻上浮  │
└──────────────────────────────┘
```
- 容器加 `ring-2 ring-indigo-400` + `shadow-tint` + `-translate-y-0.5`（用 CSS 类控制，不写死响应式逻辑）。
- 复用 DepartmentCard 现有 `ring`/`shadow` 风格，仅覆盖选中态：`selected ? 'ring-2 ring-indigo-400 shadow-tint -translate-y-0.5' : ''`。
- 卡片右上角出现**一个小选中勾标**（`Check` lucide，`w-4 h-4 text-white bg-indigo-500 rounded-full`，`absolute -top-1.5 -right-1.5`），强化「已选中」语义，且框选时便于快速识别。

**员工标签多选高亮**：
- 标签容器 `ring-1 ring-indigo-300` + `bg-indigo-50/60` + 轻描边 `border-indigo-300`。

**进入选中态时**：给选中对象一个 120ms 的 `animate-fadeIn` 勾标淡入；卡片自身 `transition-all duration-200`。

### 1.4 浮动工具条（选中集触发）

**位置**：画布顶部居中（复用 v202 §5.2 的思路），`absolute top-3 left-1/2 -translate-x-1/2`，仅在 `selectedDepts + selectedEmployees > 0` 时显示。

**布局（ASCII）**：
```
┌─────────────────────────────────────────────────────────────┐
│  ● 已选 3 部门 · 2 员工        [ 批量移动 ]  [ 批量删除 ]  [ ✕ ]  │
└─────────────────────────────────────────────────────────────┘
```

**样式**：液态玻璃胶囊条 `glass rounded-2xl px-3 py-2 shadow-xl z-[70] animate-fadeInUp`，内部按 8px 栅格 `flex items-center gap-3`。

| 元素 | 设计 | 组件/类 |
| --- | --- | --- |
| 选中计数 | `text-xs font-medium text-slate-600`，显示「已选 N」；部门/员工分颜色（部门=`text-indigo-600`，员工=`text-slate-600`） | `<span>` |
| **批量移动** | 主操作，`bg-gradient-to-r from-indigo-500 to-violet-500 text-white` 胶囊按钮（lucide `Move`），点击进入「选择目标」态（见 1.5 拖拽） | `<button>` |
| **批量删除** | 次操作，`text-red-600 border border-red-200 hover:bg-red-50` 幽灵按钮（lucide `Trash2`），点击弹 `confirm`；确认后批量删除选中，压入 undo 栈，给 toast「已删除 3 个部门」 | `<button>` |
| 撤销选择 | 关按钮 `✕`（lucide `X`），清空选中集 | `<button>` |

> 提示：批量删除仅对**部门**做整棵子树删除，对**员工**做单条删除；`confirm` 文案需提示影响范围（如「将删除 3 个部门及其全部子部门与成员」）。

### 1.5 批量移动 + 拖拽预览与反馈

**移动方式**：在选中集中，**拖拽任意一个**已选卡片 → 带动整个选中集一起移动。目标为部门 = 挂到该部门下；目标为空白/根级 = 全部升为根级。

**位移规则**（沿用现有 `handleMoveDepartment` 语义扩展为批量）：
```
selectedDepts = [A, B, C]（含各自子树）
target = T
→ 将 A、B、C **整棵子树**从原位置移除，按原相对顺序挂到 T.children 末尾
→ 各自 level 重置为 T.level + 1，子孙 level 级联 +1
→ 若 target 为 null/根 → 全部升为 level=1（根级）
→ 校验：禁止把任一选中部门移动到自身/其后代（isDescendant）；违规则整体不执行 + toast
```

**拖拽视觉反馈（核心，与单拖拽区分）**：

1. **拖拽中（drag source = batch）**：
   - 所有选中部门卡 `opacity-60` + 保留选中 ring，视觉上「整组跟随」。
   - 目标部门（当前 `over` 的 `useDroppable`）出现 `ring-2 ring-indigo-400 bg-indigo-50/50` 高亮（沿用现有 `isOver` 态）。
   - **多员工聚合为一个拖拽卡**（DragOverlay 单卡预览，替代逐个员工标签跟手）：

   ```
   ┌─────────────────────────────┐
   │  [Aggregate]  移动 3 个部门    │
   │              2 员工 + 移动组   │  ← 聚合卡
   └─────────────────────────────┘
   ```
   - 聚合卡样式：`px-4 py-3 bg-white rounded-2xl shadow-xl border-2 border-indigo-400`，顶部一行主文案 `text-sm font-bold text-slate-900`（如「移动 3 个部门」），副行 `text-xs text-slate-400`（如「含 8 名员工」），左上角一个 `Move`/`GripVertical` lucide 图标（`w-4 h-4 text-indigo-500`）。**与单拖拽卡的区别**：单拖拽卡显示单个部门名/员工名；聚合卡显示「N 个对象 + Move icon」，用 `📦`/`Move` 显式表意「这是一组」。

2. **落地**：
   - 目标卡片 `ring` 快速闪 400ms（绿色 `ring-emerald-400` 或品牌 `ring-indigo-400`，建议跟随 `over.isOver` 状态色）+ 一个短缩放弹性 `scale-105 → 100`，出现 `animate-pulse` 高点以强调「已放入」。
   - 落地后**自动清空选择集**；底部 toast「已移动 3 个部门到「研发组」」。
   - 若目标为空白/根级 → toast「已移动 3 个部门到根级别」。

3. **可撤销**：批量移动作为一个整体压入 undo 栈（快照），`Ctrl/Cmd+Z` 一次回退。
4. **合法性**：任一选中部门落在自身/后代 → 不执行，toast「不能移动到自身或其子部门」。

> 前端设计专家提示：dnd-kit 单源数据上，多选拖拽可在 `handleDragStart` 判断「当前拖拽对象 id 是否在选中集中」→ 若是则进入 batch 模式（`dragMode='batch'`），`DragOverlay` 渲染聚合卡；否则走单拖拽。移除/再插入时对整组做一次 `setDepartments` 更新（保持 useState 单一事实源），或复用历史快照（undo）。

### 1.6 事件区分总结（拖拽 vs 框选 vs 选择）

| 手势 | 判定 | 行为 |
| --- | --- | --- |
| 点击卡片 | 落在 `[data-selectable]` 上，无 Shift | 单选该项 |
| Shift/Cmd + 点击卡片 | 落在 `[data-selectable]` 上，有 Shift | 切换选中 |
| 空白区按下拖动 | 未落在 `[data-selectable]` 上 | 启动框选 marquee |
| 卡片上按下拖动 ≥8px | dnd-kit PointerSensor 激活 | 单拖拽 / 批量拖拽 |
| 点击空白 | 未落在任何对象上且无拖动 | 清空选择 |
| Esc / Ctrl+F | 任意 | 清空选择 / 打开搜索 |

---

## 2. Feature P0-B — Ctrl+F 搜索（画布定位）

> 目标：快速定位部门/员工并高亮。入口 + 高亮 + 快捷键 + 无结果提示，一体化。

### 2.1 形态决策：顶部居中浮层（推荐） vs 侧边栏集成

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| **顶部居中浮层（浅色悬浮条，Z 轴覆盖画布）** | 就近光标、不占侧边栏空间、类 Figma/白板直觉、可随时收起 | 需处理与 TopBar 的空间嵌套 | ✅ **推荐** |
| 侧边栏集成 | 常驻可发现 | 占侧边栏高度、要「先看左边再回画布」、体验割裂 | 备选 |

> 推荐顶部居中浮层：`Search` 输入条在画布**顶部居中**浮动（`absolute top-4 left-1/2 -translate-x-1/2`），带玻璃底 + `glass` 边框，不与 TopBar 重叠（TopBar 在 h-14 之外，搜索浮层落于 main 之上）。按 `Ctrl/Cmd+F` 唤起并聚焦。

### 2.2 浮层视觉

```
┌──────────────────────────────────────────────────────────────┐
│  [🔍 搜索部门或员工…]                    [N 个结果]  [Esc]  [ ⇧⇩ ]  │
└──────────────────────────────────────────────────────────────┘
```
- 容器：`flex items-center gap-2 px-3 py-2 rounded-2xl glass border border-white/50 shadow-xl animate-fadeInUp w-[360px] max-w-[80vw]`。
- 输入框：无样式化 input（`bg-transparent focus:outline-none text-sm text-slate-700 placeholder:text-slate-400`），左侧 lucide `Search`（`w-4 h-4 text-slate-400`）。
- 右侧：结果计数 `N 个结果`（`text-xs text-slate-400`，无结果则红字 `未找到匹配`）；`Esc` 提示徽标 `⌘/Ctrl`；上下箭头（`ChevronUp/Down`）在结果间循环跳转。
- **唤起**：`Ctrl/Cmd+F`（全局，`preventDefault` 拦截浏览器默认搜索）；再次按 `Esc` / 点击画布空白收起。`Ctrl/Cmd+F` 已在浏览器默认绑定，必须 `window.addEventListener('keydown', ..., { capture:true })` 并 `preventDefault`。

### 2.3 命中高亮样式（部门卡 / 员工标签 / 连线）

| 命中对象 | 高亮样式 | Tailwind |
| --- | --- | --- |
| **部门卡** | 卡片描边 + 背景色微染（主题高亮，非选中态） | `ring-2 ring-amber-400 bg-amber-50/40`（与「选中」indigo ring 区分；搜索用 amber 主题色，避免与多选选中混淆） |
| **员工标签** | 标签描边 + 淡染 | `ring-1 ring-amber-400 bg-amber-50/50` |
| **匹配文本** | 部门名/员工名内的命中片段加粗下划线 | `<mark className="bg-amber-200/60 text-slate-900 rounded px-0.5">`（建议用高亮 `<mark>` 包裹命中子串） |
| **当前聚焦命中（F1/F2 或 Enter 循环）** | 更强烈描边 + 滚动到视野 | `ring-2 ring-amber-500 shadow-tint`，并 `scrollIntoView({behavior:'smooth', block:'center'})` |

> 为区分三种视觉状态，建议固定语义色：
> - **多选选中** = `indigo`（品牌，用户主动框选）
> - **搜索命中** = `amber`（系统定位，非选中）
> - **健康度状态色**（emerald/amber/red）仅用于健康度面板，不叠加到画布命中。

### 2.4 交互行为

| 触发 | 行为 |
| --- | --- |
| `Ctrl/Cmd+F` | 唤起浮层 + 聚焦输入框 |
| 输入 | 实时过滤（`debounce 150ms`），更新命中集 `searchHits`，跳转到第一个命中 |
| `Enter` | 跳转到下一个命中（循环）；`Shift+Enter` 上一个；`↑/↓` 同 |
| `Esc` | 关闭浮层 + 清空高亮 |
| 点击命中对象 | 高亮该对象，点击画布空白收起 |
| 无结果 | 显示「未找到匹配「关键词」」；输入框 border 变为 `border-red-200` 提示（可选）；不阻塞，仍可 Esc 关闭 |

**匹配范围**：部门名（`department.name`）、员工名（`employee.name`）、工号（`employee.employeeId`）、职级码（`employee.level`）。对匹配命中的**部门**，其父链上折叠的祖先要自动展开以可见（`onToggleExpand` 沿路径展开）。

### 2.5 快捷键提示

- 空状态 / 使用说明 / TopBar 工具提示中标注：`Ctrl/Cmd + F 搜索部门或员工`。
- 侧边栏「使用说明」列表追加一项；TopBar 缩放旁可加一个 `Search` 图标按钮作为显式入口（`onOpenSearch`），便于触屏/无快捷键用户。

---

## 3. Feature P1-A — 健康度「组织优化建议」层 + 数据钻取

> 目标：在现有 HealthDrawer 的 L1/L2/L3 之上，新增**结构化的优化建议区**，并把「点击部门卡 → 聚焦单部门分析」升级为可钻取的面板态。属 P1 决策层深化。

### 3.1 建议区形态与位置

- 在 HealthDrawer 内，置于 **L2 判读汇总** 之下、**L3 编制表** 之上，作为新增 `section`：「组织优化建议」。
- 含义：基于当前 L1/L2/L3 的红黄绿判定 + 编制缺口 + 成本，**自动生成可行动的优化建议**；不改数据，只给判断与指引。

**ASCII（加入后的抽屉纵向结构）**：
```
L1 部门概览
L2 健康度指标 + 判读汇总
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
组织优化建议  (新增)   —— 建议卡片列表
  [icon] 建议标题    [P0 高优先级]    ← 关联指标徽标
  [icon] 建议标题    [P1 中]          ← 关联部门/指标
   …（按优先级排序，全绿则显示「结构稳健，暂无优化项」空态）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
L3 编制 vs 实际 vs 缺口（含成本）
```

### 3.2 建议卡片列表（icon + 建议文案 + 关联指标 + 优先级）

**单卡结构**：
```
┌────────────────────────────────────────────────┐
│ [⚠]  空岗率偏高，建议优先补充          [P0 高优先] ✓  │
│      关联指标：空岗率 18% · 技术部 · 待补 4 人        │
└────────────────────────────────────────────────┘
```
- 容器：`rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4`（**与 L2 指标卡同款玻璃卡片**）。
- 顶部行：左侧图标（lucide，`w-4 h-4 text-{状态色}`） + 建议标题 `text-sm font-semibold text-slate-800`；右侧**优先级徽标**。
- 副行：关联指标/部门/数值 `text-xs text-slate-400`，用 `·` 分隔。

**优先级徽标**（区分「建议」语义，与状态色区分）：

| 优先级 | 语义 | 视觉 | Tailwind |
| --- | --- | --- | --- |
| P0（高优） | 预警级/影响业务交付 | 红色描边胶囊 + 实心点 | `ring-1 ring-red-200 bg-red-50 text-red-600`，badge `P0` |
| P1（中优） | 关注级/需持续观察 | 琥珀胶囊 | `ring-1 ring-amber-200 bg-amber-50 text-amber-600`，badge `P1` |
| P2（低优） | 可选优化 | 灰胶囊 | `ring-1 ring-slate-200 bg-slate-50 text-slate-500`，badge `P2` |

**图标色**：P0 预警用 `text-red-500`（lucide `AlertTriangle`/`TrendingUp`）；P1 关注用 `text-amber-500`（`Activity`/`Users`）；P2 可选用 `text-slate-400`（`Sparkles`/`Lightbulb`）。

**空态**（全绿/无优化项）：显示「结构稳健，暂无优化项」+ 一个小 `CheckCircle2` emerald 图标，维持面板整体完整。

### 3.3 建议生成规则（供前端/后端落地；纯数据可单测）

> 这些是**建议内容来源**（前端设计专家据此写 `utils/suggestions.ts`，或并入 analytics）。按 L2 + L3 状态触发：

| # | 触发条件 | 建议文案（模板） | 关联指标 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 空岗率 > 20%（danger） | 「空岗严重（{vacancy}%），影响业务交付，建议优先补充关键岗位」 | 空岗率 | P0 |
| 2 | 空岗率 10–20%（warn） | 「空岗率偏高（{vacancy}%），建议关注招聘节奏」 | 空岗率 | P1 |
| 3 | 某 L1 部门缺口 > 0 且缺口成本 top | 「{部门名} 缺口 {gap} 人，缺口成本 {cost}，建议优先补编」 | 编制缺口 | 缺口成本大→P0，否则 P1 |
| 4 | 某部门超编 | 「{部门名} 超编 {|gap|} 人，建议优化人力结构/转岗」 | 超编 | P2 |
| 5 | 层级深度 ≥ 5 | 「层级偏深（{depth} 层），建议扁平化」 | 层级深度 | P1 |
| 6 | 层级深度 ≥ 7 | 「层级过深（{depth} 层），决策链长，建议压缩」 | 层级深度 | P0 |
| 7 | 管理者比 > 25% | 「管理者占比过高（{ratio}%），存在头重脚轻，建议精简管理岗」 | 管理者比 | P1 |
| 8 | 管理幅度 < 1 或 > 12 | 「管理幅度失衡（{span}），建议优化汇报线」 | 管理幅度 | P1 |
| 9 | 未配置编制数据 | 「部分部门未配置编制，建议补齐以启用空岗/成本分析」 | 编制配置 | P2 |
| 10 | 全绿 | 「结构稳健，可保持当前配置并定期复检」 | 综合 | P2 |

> 优先级建议：命中 P0 的排最前，P1 次之，P2 最后；每个建议最多取 1 条（去重，按部门/指标聚合）。建议并**不强改数据**，展示为大标题 + 副行，用户可据此在画布/职级管理中操作。

### 3.4 数据钻取：部门卡片点击 → 聚焦单部门面板态

- **触发**：HealthDrawer 中 L1 部门卡点击（沿用现有 `onFocusDept`）→ 进入**聚焦单部门分析面板态**。
- 已有基础（v202 §1.4）：聚焦时抽屉只展示该部门 + 其子树，顶部标题变「{部门名} · 组织健康度」，出现「查看全公司」按钮。
- **v2.0.3 增量（增强钻取）**：
  1. 进入聚焦态时，抽屉**自动滚动到「组织优化建议」区**并高亮该部门相关的建议（`ring` 闪 400ms），让用户「点部门 → 直接看到针对它的建议」。
  2. 聚焦态下，L1 概览仅显示该部门单卡（大卡：`w-full`，放大展示职级分布条 + 状态点 + 缺口摘要）。
  3. 建议区的「关联部门」在该部门范围内重算（focus 作用域），仅保留与该部门及其子孙相关的建议。
  4. 聚焦态下 L3 表冻结为「该部门 + 子孙」层级，便于逐层下钻。

**下钻动线**：L1 卡（点击）→ 聚焦单部门（建议+指标+编制）→ 建议卡「去处理」→ 关闭抽屉回画布定位该部门（`scrollIntoView` + 高亮）。

---

## 4. Feature P2-A — 新手引导（3 步）+ 空状态 Hero 增强

> 目标：首次使用（无数据）时，用**导入 → 拖拽 → 导出**三步引导用户建立「数据进来→可视化→产出」的完整心智；同时增强空状态 Hero。

### 4.1 引导动线方案决策：右侧引导面板（推荐） vs 弹窗 step 引导

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| **右侧引导面板（onboarding panel，靠右滑入，叠于画布上）** | 不阻断画布交互、可对照真实控件逐步操作、可持续悬挂直到完成 | 需处理与健康度抽屉的层级（z 轴） | ✅ **推荐** |
| 居中弹窗 step 引导（3 步 wizard + 进度点） | 聚焦、强制完成 | 遮挡画布、与「看得到真实控件」需求冲突 | 备选 |

> 推荐右侧引导面板（宽 384px / `w-[384px]`），从右缘滑入（`animate-slideInRight`），半透明玻璃底，覆盖在画布上但不遮挡 TopBar/Sidebar。首次（`localStorage` 标记 `org_designer_onboarding_v1` 未设置）且 `departments.length === 0` 时自动出现。用户完成三步或点击「跳过」后记录标记，不再自动弹出。

### 4.2 引导面板视觉（3 步）

```
┌──────────────────────────────────────────┐
│  🎓 新手引导   3/3    [✕ 跳过]             │
│  用三步构建您的组织架构图                     │
│  ──────────────────────────────           │
│  [✓] ① 导入数据  上传员工Excel / 组织架构    │
│        左栏「文件上传」                     │
│  [○] ② 拖拽编排  拖拽部门/员工调整结构       │
│        画布直接拖拽，双击编辑名称            │
│  [ ] ③ 导出成果  PNG / Excel / 诊断报告     │
│        顶部「健康度」查看优化建议             │
│  ──────────────────────────────           │
│  [ 下一步 → ]   [ 跳过引导 ]                │
└──────────────────────────────────────────┘
```

- 容器：`fixed inset-y-0 right-6 top-24 w-[384px] max-w-[90vw] rounded-3xl glass border border-white/50 shadow-2xl p-5 animate-slideInRight z-[85]`（`top-24` 避开 TopBar h-14，`right-6` 留呼吸感）。
- 标题行：`🎓`（lucide `GraduationCap`，`w-5 h-5 text-indigo-500`）+「新手引导」`text-sm font-bold text-slate-900` + 进度 `3/3` `text-xs text-slate-400` + 右上 `✕` 跳过。
- **步骤清单**（每步：状态标 + 标题 + 说明）：
  - 状态标：已完成 `✓` 用 `w-7 h-7 rounded-full bg-emerald-500 text-white`；当前步用 `bg-indigo-500 text-white` + `animate-pulse` 圆点；未开始用 `bg-slate-200 text-slate-500`。
  - 标题 `text-sm font-semibold text-slate-800`，说明 `text-xs text-slate-500`。
- **底部按钮**：主 CTA「下一步 →」（`bg-gradient-to-r from-indigo-500 to-violet-500 text-white`），次 CTA「跳过引导」（`text-slate-500 hover:bg-slate-100`）。

### 4.3 三步动线（与真实控件联动）

| 步骤 | 引导文案 | 用户动作 | 完成条件 |
| --- | --- | --- | --- |
| ① 导入数据 | 左栏「文件上传」上传员工Excel / 组织架构 | 上传文件 | `departments.length > 0` |
| ② 拖拽编排 | 画布拖拽部门/员工调整结构，双击名称编辑 | 任意一次 `handleMoveDepartment/MoveEmployee` | 执行过拖拽 |
| ③ 导出成果 | 顶部「健康度」查看优化建议，或左侧导出PNG/Excel | 打开健康度或执行导出 | `onOpenHealth` 或导出动作 |

- 每步完成自动打 `✓` 并推进到下一步，进度条（`3/3` 与圆点）实时更新。
- 步骤②、③ 完成条件跨组件，需要 App 层把「拖拽发生 / 健康度打开 / 导出发生」的信号传递给引导组件（可在 App 中挂 `onOnboardingStepDone(step)` 回调，或在 `onMove*` / `onOpenHealth` / `onExport*` 里同步推进）。

### 4.4 空状态 Hero 增强（v2.0.2 基础上）

现有 `EmptyStateHero` 三步是「下载模板→填写数据→上传文件」。v2.0.3 把步骤统一为**「导入→拖拽→导出」**并强化视觉：

- **图标区**：强化为 aurora 光圈（`bg-gradient-to-br from-indigo-500/20 to-violet-500/20` + 一个淡淡 pulse 环 `animate-pulse-slow`）。
- **步骤文案更新**：
  - ① 导入数据 —— 去【工具模板】下载「员工信息」「组织架构」Excel，在左栏「文件上传」上传
  - ② 拖拽编排 —— 在画布拖拽部门/员工，双击名称编辑，右键管理层级
  - ③ 导出成果 —— 左栏导出 PNG / Excel，顶部【健康度】看优化建议
- **CTA 行**：主 CTA「开始设计（下载模板）」+ 次 CTA「载入示例数据」+ **第三个入口「查看新手引导」**（打开右侧引导面板）。
- **引导入口联动**：Hero 中「查看新手引导」与右上引导面板互跳；进入有数据态后面板自动消失。

**关闭条件**：`departments.length > 0` 时所有引导自动消失，切换到正常画布。

---

## 5. Feature P1-B — 行业模板（载入入口 + 预览缩略卡）

> 目标：为用户提供**现成的行业组织架构模板**（如互联网/制造/金融/零售/医疗/教育），一键载入画布，降低从零搭建成本。属 P1。

### 5.1 入口决策：扩展 TopBar【工具模板】下拉（推荐）

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| **扩展现有【工具模板】下拉**：新增「行业模板」分组 | 入口集中、语义一致（都是「模板」）、不新增 TopBar 按钮（避免拥挤） | ✅ 推荐 |
| 顶部/侧边栏新增独立「行业模板」按钮 | 独立入口更醒目 | 备选（TopBar 右区已较满） |

> 推荐在 TopBar 左区「工具模板」下拉内，**顶部新增一个分隔分组「载入行业模板」**，下面列 4–6 个行业模板（每项含缩略图 + 名称 + 描述 + 载入按钮）。点击 Carousel 面板（见 5.3）进一步预览。

### 5.2 下拉样式（扩展后）

```
┌─ 工具模板 ──────────────────────────────────┐
│  ⬇ 下载 Excel 模板                           │
│   🧾 员工信息模板   含姓名/工号/职级/一~六级部门  │
│   🏢 组织架构模板   含部门/级别/负责人列          │
│  ───────────────────────────────             │
│  📐 载入行业模板  (新)                         │
│  ├─ 互联网科技 ───────  [ 载入 ]               │
│  ├─ 智能制造  ───────  [ 载入 ]               │
│  ├─ 零售连锁  ───────  [ 载入 ]               │
│  ├─ 金融 / 银行 ─────  [ 载入 ]               │
│  └─ 医疗健康  ───────  [ 载入 ]               │
└──────────────────────────────────────────────┘
```
- 下拉容器沿用现有 `w-64 rounded-2xl bg-white/90 backdrop-blur-xl border border-slate-100 shadow-xl p-2`；新增分隔线 `my-1.5 border-t border-slate-100` 与分组标题 `px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-400`。
- 每个行业模板项：icon 缩略块（`w-9 h-9 rounded-lg bg-{theme}-50 text-{theme}-500 grid place-items-center`，用对应行业的 lucide 图标）+ 主文案 `text-sm font-semibold text-slate-800` + 说明 `text-xs text-slate-400`；右侧「载入」`text-xs text-indigo-600 hover:underline`。
- 点击「载入」→ 替换当前场景 `departments` 为该模板组织树 + 可选 `levelConfigs`，压入 undo 栈，toast「已载入「互联网科技」模板」。

### 5.3 模板预览缩略卡（可选增强：载入前预览）

- 点击行业名或「预览」→ 弹出**模板画册**（`popover`/`modal`，居中，`w-[640px] rounded-3xl glass shadow-2xl animate-fadeInUp`），展示该模板的**缩略卡网格**。
- **缩略卡**：每张为模板的微缩组织图预览（用 SVG/CSS 画 3–5 个节点 + 简易连线，或直接渲染小尺寸 `OrgChart` 只读）。卡上显示模板名 + 描述 + 人数/部门数摘要 +「使用此模板」按钮。

```
┌─ 行业模板 · 互联网科技 ──────────────────────────── ✕ ┐
│  ┌───────────┐  ┌───────────┐  ┌───────────┐          │
│  │  [缩略图]  │  │  [缩略图]  │  │  [缩略图]  │          │
│  │ 技术部     │  │ 产品部     │  │ 运营部     │          │
│  │ 8部门/26人 │  │ 6部门/18人 │  │ 5部门/14人 │          │
│  │ [使用此模板]│  │ [使用此模板]│  │ [使用此模板]│          │
│  └───────────┘  └───────────┘  └───────────┘          │
└────────────────────────────────────────────────────────┘
```
- 缩略图：`aspect-[4/3] rounded-xl bg-slate-50 border border-slate-100`，内部用 `<svg>` 画简化树（`<circle>` 节点 + `<line>` 连线，节点高亮用对应 `LevelConfig.color`）。顶部显示模板名 `text-sm font-bold text-slate-800`，底部摘要 `text-xs text-slate-400`（N 部门 · N 员工）。
- 选择「使用此模板」→ 关闭画册、载入模板、`scrollIntoView` 居中。

### 5.4 行业模板内容（数据建议）

> 前端/后端提供的数据结构，每个模板是一组「组织树 + 职级配置」（可直接 `buildDepartmentTree` 复用）。例如：

| 模板 | 部门示例 | 职级 | 用途 |
| --- | --- | --- | --- |
| 互联网科技 | 技术/产品/设计/运营/市场/人力 | L1-L5 + E 序列 | 通用 SaaS/互联网 |
| 智能制造 | 研发/生产/质量/供应链/销售 | L1-L4 管理序列 | 制造业 |
| 零售连锁 | 总部/区域/门店/采购/物流 | L1-L4 | 连锁零售 |
| 金融/银行 | 风控/信贷/运营/零售金融/合规 | L1-L5 + 专业序列 | 金融机构 |
| 医疗健康 | 临床/护理/医技/行政/后勤 | L1-L3 | 医院/健康 |

> 每个模板建议含一个 `thumbnail`（简化的节点/连线 SVG 数据）供缩略卡复用；载入时把 `department.level` / `parentId` / `children` 一次性构造成组织树，并覆盖当前场景的 `levelConfigs`（缺省保留用户现有职级配置，不强制覆盖，可加「覆盖职级配置」复选）。

---

## 6. 2026 视觉融合要点（v2.0.3 增量）

延续 v2.0.1 §4 / v2.0.2 §5 的玻璃拟态 / aurora / 圆角 / 动效体系。本节只列**新增/调整**。

### 6.1 需新增的 Tailwind / CSS 资源

**建议注册到 `tailwind.config.js`**（或退回任意值写法）：

```js
keyframes: {
  flashHighlight: {   // 落地/命中闪 400ms
    '0%': { boxShadow: '0 0 0 3px rgba(99,102,241,0.4)' },
    '100%': { boxShadow: '0 0 0 0 rgba(99,102,241,0)' },
  },
  marqueeGrow: null,   // 框选矩形实时更新即可，无需动画
},
animation: {
  flashHighlight: 'flashHighlight 0.4s ease-out',
},
```

> 若不改配置，可用 `animate-[flashHighlight_0.4s_ease-out]`。框选的 `<mark>` 高亮与搜索浮层用已有 `fadeInUp`。

### 6.2 新增组件的形态清单

| 组件 | 形态 | 关键 class |
| --- | --- | --- |
| 框选矩形（marquee） | 画布浮动层 | `absolute rounded-lg border-2 border-indigo-400 bg-indigo-500/12 pointer-events-none` |
| 批量选中态（部门卡） | ring + 勾标 | `ring-2 ring-indigo-400 shadow-tint -translate-y-0.5` + 右上 `Check` 勾标 |
| 批量选中态（员工标签） | ring | `ring-1 ring-indigo-300 bg-indigo-50/60` |
| 浮动工具条 | 画布顶部居中胶囊 | `absolute top-3 left-1/2 -translate-x-1/2 glass rounded-2xl px-3 py-2 shadow-xl z-[70] animate-fadeInUp` |
| 批量拖拽聚合卡（DragOverlay） | 聚合卡片 | `px-4 py-3 bg-white rounded-2xl shadow-xl border-2 border-indigo-400` |
| 搜索浮层 | 画布顶部居中 | `absolute top-4 left-1/2 -translate-x-1/2 w-[360px] glass rounded-2xl shadow-xl animate-fadeInUp` |
| 搜索命中（部门卡/员工） | 主题高亮 | `ring-2 ring-amber-400 bg-amber-50/40` / `ring-1 ring-amber-400` |
| 建议卡片 | 玻璃卡片（同 L2 指标卡） | `rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4` |
| 建议优先级徽标 | 小红/黄/灰胶囊 | `ring-1 ring-{red|amber|slate}-200 bg-{red|amber|slate}-50 text-{red|amber|slate}-600` |
| 新手引导面板 | 右缘滑入玻璃面板 | `fixed inset-y-0 right-6 top-24 w-[384px] rounded-3xl glass shadow-2xl animate-slideInRight z-[85]` |
| 行业模板画册 | 居中弹窗网格 | `w-[640px] rounded-3xl glass shadow-2xl animate-fadeInUp` |

### 6.3 动效增量（克制）

- 框选矩形：实时跟随（0ms，无需动画），纯视觉层。
- 批量选中勾标：`animate-fadeIn` 120ms 淡入；卡片 `transition-all duration-200`。
- 批量落地 / 搜索命中：`flashHighlight` 400ms 闪 + 目标卡 `scale-105→100`。
- 搜索浮层 / 新手引导面板：`animate-fadeInUp` / `animate-slideInRight`（240ms）。
- 建议卡 / 行业模板缩略卡：`.animate-fadeInUp` 缓入（仅首屏/首次打开抽屉、画册时）。

### 6.4 字体 / 圆角 / 间距（沿用 v2.0.1 §4.2）

- 字体层级、圆角（`rounded-lg` 小控件 / `rounded-xl` 控件 / `rounded-2xl` 卡片 / `rounded-3xl` 面板）、8px 栅格（主区 `p-6`、卡内 `p-4`、区块 `space-y-4`）**沿用**，不重复。

---

## 7. 落地清单（给前端设计专家）

| # | 事项 | 涉及 | 说明 |
| --- | --- | --- | --- |
| 1 | 画布选中态 + 框选 marquee | `OrgChart.tsx` | 新增 `selectedDepts/selectedEmployees` 状态 + `marquee` 矩形（空白区启动，`pointer-events-none`）+ 相交测试 + `data-selectable` 标记 |
| 2 | 批量选中态视觉 + 勾标 | `DepartmentCard.tsx` / `OrgChart.tsx` | 部门卡 `ring-2 ring-indigo-400` + `Check` 标；员工标签 `ring-1 ring-indigo-300`；浮动态 `-translate-y-0.5` |
| 3 | 浮动工具条 | `OrgChart.tsx` | 批量移动 / 批量删除 / 撤销选择；计数文案 |
| 4 | 批量移动 + 聚合拖拽卡 | `OrgChart.tsx` | batch 模式 DragOverlay 聚合卡；整组移动（保留相对顺序 + level 级联）；`isDescendant` 校验；落地闪 + 清选择 + toast |
| 5 | Ctrl+F 搜索浮层 | `OrgChart.tsx` / `App.tsx` | 顶部居中浮层 + `Ctrl/Cmd+F` 唤起（`preventDefault`）+ `debounce` 过滤 + amber 命中高亮 + `Enter/↑↓` 循环 + 无结果提示 + 命中祖先自动展开 |
| 6 | 健康度建议层 | `HealthDrawer.tsx` / 新 `utils/suggestions.ts` | 建议卡片（icon + 文案 + 关联指标 + 优先级）+ 优先级生成规则 + 空态；聚焦态钻取增强 |
| 7 | 新手引导 + Hero 增强 | `OrgChart.tsx` / `App.tsx` / 新组件 | 右侧引导面板（导入→拖拽→导出 + 进度 + 跳过）+ localStorage 标记 + Hero 三步更新 + 联动完成信号 |
| 8 | 行业模板 | `TopBar.tsx` / 新 `utils/templates.ts` / 画册组件 | 工具模板下拉新增「载入行业模板」分组 + 预览缩略卡 + 载入逻辑（`buildDepartmentTree` 复用） |
| 9 | Tailwind / 视觉资源 | `index.css` / `tailwind.config.js` | `flashHighlight` 动画 + 建议优先级 / 命中 / 勾标等新增资源 |
| 10 | 更新版本徽标 | `TopBar.tsx` | `v2.0.2` → `v2.0.3`（若本期提升版本号）；package.json version 同步 |

> 约束：本规格仅定义**交互与视觉**；不改变既有部门树构建、拖拽、导出等**业务逻辑**。行业模板内容为**数据源任务**（可先内置 2–3 个示例，后续再扩充）。建议/搜索为**纯数据/纯 UI** 增量，不破坏现有状态流。

---

## 8. 附：验证口径（供测试专家）

- **框选**：空白区拖出矩形 → 相交卡片/员工被选中；落点在卡片上不触发框选；释放后矩形消失且进入「已选 N」。
- **多选高亮**：选中卡出现 `ring-2 ring-indigo-400` + 勾标；Shift+点击可切换；点击空白/Esc 清空。
- **批量移动**：拖动选中任一卡 → 整组移动且 level 正确；目标是自身/后代被拦截并提示；落地后清空选择 + toast；Ctrl+Z 可整体回退。
- **聚合拖拽卡**：多选时 DragOverlay 显示「移动 N 个部门」聚合卡，而非逐个员工卡。
- **Ctrl+F**：呼唤/收起、实时过滤、命中 amber 高亮、`Enter/↑↓` 循环、无结果提示、命中祖先自动展开；`Ctrl/Cmd+F` 拦截浏览器搜索。
- **健康度建议**：给定 L2/L3 状态，断言命中建议条数与优先级排列正确；聚焦单部门时建议只显示该子树相关；全绿空态正确。
- **新手引导**：首次自动弹出右侧面板；完成三步或跳过写 localStorage；`departments.length>0` 后不再自动弹出；Hero 三步文案与引导一致。
- **行业模板**：「载入部门模板」后 `departments` 替换正确；缩略图画册可预览；载入可 undo。

---

## 9. 参照文件

`src/App.tsx`、`src/components/OrgChart.tsx`、`src/components/DepartmentCard.tsx`、`src/components/TopBar.tsx`、`src/components/Sidebar.tsx`、`src/components/HealthDrawer.tsx`、`src/types/index.ts`、`src/utils/analytics.ts`、`src/utils/statusUI.ts`、`src/utils/excel.ts`、`src/index.css`、`docs/design/v201-design.md`、`docs/design/v202-design.md`。
