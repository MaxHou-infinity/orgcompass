# OrgCompass v2.0.9 · 诊断口径修正方案（诊断口径/数据分析视角）

> 作者：analytics-expert（团队 v209-roadmap）· 本任务 = 团队任务 **t2**。
> 依据当前仓库实测（`src/utils/analytics.ts`、`src/types/index.ts`、`src/utils/analytics.test.ts`、`src/components/HealthDrawer.tsx`、`docs/v208-hr-value-audit.md`、`docs/v209-v300-version-plan.md`）。凡引用代码行号以当前 `main` 为准，落地时以实际行号复核。
> 文档性质：**可执行算法方案**，供 Captain 汇总进 `docs/v209-roadmap.md`。本方案只读仓库、不改代码。

---

## 0. 范围边界（先钉死，避免膨胀）

本版本（v2.0.9）口径修正**只改「怎么算」，不改「存什么」**，四道硬边界：

1. **不动数据模型**：`Department` / `Employee` / `Scenario` / `ProjectFile` 字段**零新增**。因此 `.orgproj` 项目文件**天然向后兼容**（无迁移、无破坏性变更）。
2. **不新增「负责人类型」字段**（专职/兼岗/副职/外部）：那是 v2.1.0 岗位（Position）模型的事。本版本只能用现有字段做「尽力而为」的判定，残留失真必须显式标注（见 §C.4）。
3. **不新增 `HealthStatus` 状态**：继续只用 `'healthy' | 'warn' | 'danger'`。「未配置/无数据」仍由 UI 层 `isHeadcountUnset` 呈现灰态，不在 analytics 层引入第四态。
4. **不改空岗率**：空岗率口径已在 v2.0.8 对齐（`analytics.ts` L501-534），本版本**只同步更新它的口径文案**（`METRIC_CALIBER_NOTES`），不动计算。

一句话结论：**管理幅度改「中位数 + 极值 + 部门级直管明细」，层级深度改「max + P50/P90 + 最深链定位」，管理者比用现有字段剔除「外部负责人」并统一去重口径、保留「含管理者全员」分母但双口径展示；三项全部可复算、可单测，不碰 `.orgproj`。**

---

## A. 管理幅度：算术平均 → 中位数 + 极值 + 直管分布

### A.1 现状问题（代码事实）

`computeL2`（`analytics.ts` L450-472）现在：

```ts
spanReports += d.employees.filter((e) => !e.isVirtual).length;  // 只算「节点直挂员工」
span = round1(spanReports / spanLeaders);                        // 算术平均
```

两个失真（与 v208-hr-value-audit §1-A 一致）：

1. **均值被极端值稀释**：一个 40 人直管部门 + 若干 2 人部门，平均可能落在「适中」区间，掩盖单点失控。
2. **中间管理层直管被系统性低估**：`d.employees` 只含「节点直挂 IC」，不含「下一层子部门负责人」。在多层科层组织里员工都落在叶子节点（`excel.ts` `buildDepartmentTree` 把员工挂到最深匹配层），中间层负责人（如「研发部」）节点上往往只有他自己 → 直管被算成 0~1，高频误触发「负责人无人直管（critical）」「管理幅度偏窄」。

### A.2 修正方案：直管人数（directReports）统一口径

**推荐采用审计的「下一层子部门负责人数 + 节点直挂 IC 数」作为直管人数**（记为 `directReports`），它同时修正上述两个失真：

```ts
/**
 * 某部门负责人的直管人数：
 *   = 节点直挂非虚拟 IC 数 + 下一层「有负责人」子部门数
 * 语义：经理直接管理的人 = 直接汇报给 TA 的一线员工 + 直接汇报给 TA 的下一级管理者。
 */
function directReports(dept: Department): number {
  const directICs = dept.employees.filter((e) => !e.isVirtual).length;
  const directManagers = dept.children.filter((c) => c.leaderId || c.leaderName).length;
  return directICs + directManagers;
}
```

理由（为什么选这个口径，而不是「保持节点直挂只改标注」）：

- 修「中间管理层低估」是**数据正确性**问题，不是文案问题——单靠「标注语义」无法让一个被算成 0 人的经理在报告里恢复成真实直管数。改口径才是根治。
- 「下一层有负责人子部门数」对「负责人恰好也是员工表里的一条记录」不敏感，无需新增字段即可计算。
- 对**扁平单层组织**（IC 直接挂部门、无子部门）退化为「节点直挂 IC 数」，与旧口径**完全一致**，不产生回归。

### A.3 聚合口径：中位数为主，均值/极值/分布为辅

```ts
interface SpanRow {
  deptId: string;
  deptName: string;
  directReports: number;   // = directReports(dept)
}

interface SpanBreakdown {
  count: number;           // 有负责人部门数（样本量）
  median: number | null;   // 主值：直管数中位数（round1）
  mean: number | null;     // 均值（保留作参考，不参与判定）
  min: number | null;
  max: number | null;      // 极值：最宽直管数（用于「单点失衡」告警）
  distribution: SpanRow[]; // 每个有负责人部门的直管数，按 directReports 降序
}

function computeSpanBreakdown(roots: Department[]): SpanBreakdown {
  const rows: SpanRow[] = [];
  for (const d of flattenDepartments(roots)) {
    if (d.leaderId || d.leaderName) {
      rows.push({ deptId: d.id, deptName: d.name, directReports: directReports(d) });
    }
  }
  if (rows.length === 0) {
    return { count: 0, median: null, mean: null, min: null, max: null, distribution: [] };
  }
  const values = rows.map((r) => r.directReports).sort((a, b) => a - b);
  const median = percentile(values, 0.5);   // 偶数取中间两值平均，round1
  const mean = round1(values.reduce((s, v) => s + v, 0) / values.length);
  return {
    count: rows.length,
    median,
    mean,
    min: values[0],
    max: values[values.length - 1],
    distribution: rows.slice().sort((a, b) => b.directReports - a.directReports),
  };
}
```

**中位数与现有 `HealthThresholds` 阈值的协同（关键决策）：**

- `span.value` 由「均值」改为「**中位数**」，`span.status = spanStatus(median, thresholds)`（阈值区间 `spanHealthyMin~spanHealthyMax` = 3–8 **保持不变**，仍按每人直管数判定）。理由：阈值本就是对「单个经理直管几人」的健康区间，中位数是「典型经理直管几人」的无偏估计，语义最贴合；均值因长尾右偏，天然高于中位数，会系统性高估「典型直管」。
- **极值单独兜底，不被中位数抹平**：`spanBreakdown.max` 与 `spanWarnMax`（默认 12）比较，若 `max > spanWarnMax`，即使中位数落在健康区间，也要在**部门级建议**里把最宽的部门标 `critical`。这正是「一个 40 人部门不再被其它窄部门抹平」的落地方式——**L2 聚合看中位数，L2 之外靠部门级直管明细 + 建议承接单点失衡**。
- `span.verdict` 三档文案改为：
  - healthy：`「典型直管 X 人（中位数），幅度适中；最宽 Y 人，无失控单点」`（Y 未超 `spanWarnMax` 时）
  - warn：`「典型直管 X 人，幅度偏窄/偏宽，建议优化汇报线」`
  - danger：`「典型直管 X 人，管理幅度失衡；最宽 Y 人存在失控/冗余风险」`
  - 不可算（`count===0`，无任何有负责人部门）：保持现有 `无法计算管理幅度（未设置部门负责人）` 文案。

### A.4 对呈现的影响（不写组件代码，只描述）

- `HealthDrawer` L2 卡片当前只渲染单个 `m.value`（`fmt(m.value, m.unit)`）。改后：主数字显示**中位数**；卡片下方新增一行小字「极值 min–max」+「N 个有负责人部门」；点击展开/悬浮显示直管数分布（复用 L3 表格思路，列出最宽的若干部门）。
- `DiagnosticReport` 单场景报告同样把「管理幅度 = 中位数」+「最宽部门清单」写进指标卡。
- **联动改动**：`generateDeptSuggestions`（`analytics.ts` L789-832）现用 `d.employees.filter(!isVirtual).length` 判「偏窄/偏宽/无人直管」，必须**统一改用 `directReports(dept)`**，否则 L2 中位数与部门级建议的口径打架。

### A.5 残留失真（需在口径说明里写明）

- **只看「有负责人」的部门**：未设负责人的部门不进中位数样本（与旧口径一致）。建议口径说明补一句「未设负责人部门不参与管理幅度，其缺失另见『负责人无人直管/未配置负责人』提示」。
- **下一层子部门负责人若「挂名」**（有 leaderId 但非真实汇报关系），会算进直管数——本版本无字段可辨，留待 v2.1.0。

---

## B. 层级深度：全组织最大 → max + P50/P90 + 最深链定位

### B.1 现状问题

`computeTreeDepth`（`analytics.ts` L545-552）只返回**全组织最大路径层数**。一条「总部-事业部-中心-区-门店」深链会把整个组织判成「层级过深」，即使 90% 的部门只有 3 层。少数深链被当成全组织结论。

### B.2 修正方案：深度分布 + 最深链定位

```ts
interface DepthBreakdown {
  max: number;           // 最大层数（= 旧 computeTreeDepth，根 L1=1）
  p50: number;           // 所有部门深度的中位数
  p90: number;           // 所有部门深度的 90 分位（nearest-rank，整数）
  deepestDeptId: string; // 最深链路的叶子部门 id
  deepestPath: string[]; // 根 → … → 最深叶子 的部门名链（如 ['总部','事业部','中心','区','门店']）
  deptCount: number;     // 参与统计的部门总数（空树为 0）
}

function computeDepthBreakdown(roots: Department[]): DepthBreakdown {
  // 1) 从结构重算每个部门的深度（根=1），不信任 Department.level（防手工/导入导致 level 与真实深度不一致）
  const depths: number[] = [];
  const walk = (d: Department, depth: number, path: string[]) => {
    depths.push(depth);
    if (d.children.length === 0) {
      // 记录最深叶子
      if (depth > (deepest.depth ?? 0)) { deepest = { depth, path: path.concat(d.name), deptId: d.id }; }
    }
    for (const c of d.children) walk(c, depth + 1, path.concat(d.name));
  };
  let deepest = { depth: 0, path: [] as string[], deptId: '' };
  for (const r of roots) walk(r, 1, []);
  if (depths.length === 0) return { max: 0, p50: 0, p90: 0, deepestDeptId: '', deepestPath: [], deptCount: 0 };
  const sorted = depths.slice().sort((a, b) => a - b);
  return {
    max: deepest.depth,
    p50: percentile(sorted, 0.5),
    p90: percentileNearestRank(sorted, 0.9),   // index = Math.ceil(0.9 * n) - 1
    deepestDeptId: deepest.deptId,
    deepestPath: deepest.path,
    deptCount: sorted.length,
  };
}
```

**分位数算法约定（保证可复算、可单测）：**

- 统计对象 = **所有部门节点**（不是「叶路径」）的深度。理由：HR 关心的是「大多数部门在第几层」，按部门统计比按叶路径统计更能表达「90% 部门只有 3 层」；叶路径会被少数深叶拉长。若想额外看「叶路径深度分布」，可作为可选补充，但 v2.0.9 **默认只按部门节点统计**。
- 中位数：`n` 为奇数取中间，偶数取两中间值平均（深度为整数时平均仍可能是 .5，用 `round1`）。
- P90：**nearest-rank**（`index = Math.ceil(0.9 * n) - 1`），保证 P90 是真实存在的整数层数，避免出现「3.7 层」这种无意义值。

### B.3 与阈值 / 判定 / 呈现的协同（关键决策）

- **`depth.value` 保持 = max（最坏情况），`depth.status = depthStatus(max)` 不变**。理由：一条 7 层深链即使罕见，仍是真实的结构风险，红黄绿应继续把它点亮；修正的目的是**不再让 max 独占「全组织结论」**，而不是把 max 藏起来。
- 同时把 `p50 / p90 / deepestPath` 作为 `DepthBreakdown` 附到 L2 指标上，`verdict` 文案改为**区分「典型深度」与「最深链路」**：
  - healthy：`「层级精简（最深 N 层）；典型 P50=X 层，P90=Y 层」`
  - warn：`「最深 N 层，典型 P50=X / P90=Y 层；偏深主要来自个别深链，建议定位最深链路部门」`
  - danger：`「层级过深（最深 N 层）；典型 P50=X / P90=Y 层，最深链路位于 Z（根→…→叶），建议压缩」`
  - 空树：保持现有 `暂无部门数据，无法评估层级深度` 文案（现有单测断言 `toContain('无法评估层级')`，不破坏）。
- **呈现影响**：`HealthDrawer`/`DiagnosticReport` 的「层级深度」卡片在 `max` 大数字下新增一行「P50 / P90」+「最深链路：总部 → … → 门店」的定位文案；`DeepestPath` 让 HRBP 能一键定位到「该压的是哪条链」，而不是无差别压全组织层。

### B.4 残留失真

- 阈值 `depthHealthyMax/depthWarnMax` 仍只作用于 `max`。若后续想让「P90 也参与判定」，需在阶段预设里新增阈值字段——本版本**不做**，避免阈值结构膨胀（与 v2.0.8 阶段预设保持兼容）。

---

## C. 管理者比：剔除外部负责人 + 统一去重口径 + 分母双口径

### C.1 现状问题

`computeL2`（`analytics.ts` L441-499）：

```ts
if (d.leaderId) managerKeys.add(`id:${d.leaderId}`);
else if (d.leaderName) managerKeys.add(`name:${d.leaderName}`);   // ① id/name 混用可能双计
...
managerRatio = round1((managerCount / totalEmployees) * 100);      // ② 分母含管理者本人
// ③ 未剔除兼岗/副职/外部负责人
```

三个失真（与审计 §1-C 一致），外加一个**隐藏 bug**：

- **隐藏 bug（去重口径混用）**：同一人——A 部门用 `leaderId`、B 部门只填了 `leaderName`——会被记成 `id:xxx` 与 `name:xxx` 两个 key，**双计**。需统一 canonical key。
- **外部负责人**：`leaderId/leaderName` 指向不在员工名册内的人（组织外 VP / 上级集团 / 挂名），记入分子却不在分母员工里 → 抬高比值。
- **分母含管理者**：`totalEmployees` 含负责人本人 → 语义是「管理者 ÷ 含管理者全员」，与 HR 直觉「每几名非管理员工配一名管理者」不符。
- **兼岗/副职**：无字段可辨（见 C.4）。

### C.2 可落地的判定规则（现有字段，伪代码）

```ts
interface ManagerBreakdown {
  internalManagers: number;   // 内部负责人数（去重、剔除外部）—— 分子
  externalManagers: number;   // 外部负责人数（不在员工名册内）—— 不计分子，仅展示
  multiDeptManagers: number;  // 兼岗：同一 key 兼任 ≥2 个部门的人数（仅展示，不改变去重计数）
  totalEmployees: number;     // 分母（含管理者、非虚拟）
  nonManagerEmployees: number;// 非管理员工数（辅助口径用）
}

function computeManagerBreakdown(roots: Department[]): ManagerBreakdown {
  const allDepts = flattenDepartments(roots);
  const emps = collectEmployees(wrapper(roots), /*includeVirtual=*/ false);

  // 员工名册查找集合：工号 + 姓名（用于判定「负责人是否在员工表内」）
  const byEmployeeId = new Set<string>(emps.map((e) => e.employeeId).filter(Boolean));
  const byName = new Set<string>(emps.map((e) => e.name).filter(Boolean));

  // canonical key：优先工号，其次姓名；统一去重（修 id/name 混用双计 bug）
  const keyOf = (d: Department) =>
    d.leaderId ? `id:${d.leaderId}` : d.leaderName ? `name:${d.leaderName}` : null;

  const deptCountByKey = new Map<string, number>();
  for (const d of allDepts) {
    const k = keyOf(d);
    if (k) deptCountByKey.set(k, (deptCountByKey.get(k) ?? 0) + 1);
  }

  // 内部 vs 外部：负责人 key 是否命中员工名册
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const [k] of deptCountByKey) {
    const isId = k.startsWith('id:');
    const raw = k.slice(k.indexOf(':') + 1);
    const internalHit = isId ? byEmployeeId.has(raw) : byName.has(raw);
    (internalHit ? internal : external).add(k);
  }

  const internalManagers = internal.size;
  const multiDeptManagers = [...deptCountByKey].filter(([k, n]) => n >= 2 && internal.has(k)).length;

  return {
    internalManagers,
    externalManagers: external.size,
    multiDeptManagers,
    totalEmployees: emps.length,
    nonManagerEmployees: Math.max(emps.length - internalManagers, 0),
  };
}
```

**主口径（红黄绿判定，推荐）：**

```
管理者比 = internalManagers ÷ totalEmployees × 100   // 分母保持「含管理者、非虚拟」
managerRatio.status = managerRatioStatus(ratio, thresholds)   // ≤15 健康 / ≤25 关注 / >25 预警，阈值不变
```

**推荐分母「保持含管理者全员」而非「改非管理者」，理由：**

1. 现有三档阶段阈值（`managerHealthyMax=15 / managerWarnMax=25` 等）是在「÷含管理者全员」口径下标定的；若改分母为「非管理者」，比值会系统性上移约 `1/(1-r)`，必须**同步重标定三档阈值**——这是 hr-expert 的决策，且牵动 v2.0.8 已发布的阶段预设，超出本版本「只改口径不改阈值标定」的边界。
2. 「管理者 ÷ 含管理者全员」作为「管理层占组织总盘子的比例（管理成本/官僚化信号）」，语义自洽；HR 直觉里的「每几名非管理员工配一名管理者」用**辅助口径**补足即可。

**辅助口径（仅展示、不参与红黄绿判定）：**

```
非管理者口径 = internalManagers ÷ nonManagerEmployees × 100   // nonManagerEmployees>0 时
```

> 卡片同时展示「管理者 X 人 ÷ 员工 Y 人（含管理者）= Z%；相当于每 T 名非管理员工配 1 名管理者」，一次讲清两种读法，避免歧义。

### C.3 对现有测试 fixture 的**必然冲击（必须提前告知 Captain/hr-expert）**

「外部负责人剔除」会让**现有大量单测失效**：当前测试里 `leaderId: 'L01'` 的负责人**并不在 employees 列表里**（如 `analytics.test.ts` L118、L139、L341 等），按 C.2 规则这些负责人会被判「外部」而剔除 → `managerRatio` 从「有值」变成「0% 或 null」。

这是**修正的预期后果，不是 bug**：真实产品里负责人由 `App.tsx` L250-251 从 `allEmployees` 选择，负责人**本就在员工名册内**；测试 fixture 是人为把负责人放到名册外。落地时必须**同步改造测试 fixture**（把负责人加进 `employees` 并给对 `employeeId`/`name`，或显式构造「内部 vs 外部」两组对照），并新增「外部负责人被剔除」的正向用例。**这一点要在路线图里作为「测试改造范围」显式列出，否则合并时单测会大面积红。**

### C.4 残留失真（本版本无法消除，需留痕到 v2.1.0）

- **兼岗**：同一人兼任多部门负责人，去重后已只算 1（不会虚高分子），本方案额外给出 `multiDeptManagers` 计数**暴露**它，但无法区分「真兼任管理」与「挂名」。挂名造成的「头重脚轻」误读本版本无法根除。
- **副职**：现有字段完全没有「正职/副职」区分，无法剔除。若组织里大量「副院长/副主任」被设为负责人，管理者比仍会偏高。
- 以上两项的**根治方案 = v2.1.0 引入「负责人类型」字段**（专职/兼岗/副职/外部），本方案已把判定点（`computeManagerBreakdown` 的 internal 判定）写成独立函数，届时只需在类型字段落地后替换 internal 判定逻辑即可，**不改调用方**。

---

## D. 统一出口

### D.1 数据结构扩展（向后兼容，不破坏 `.orgproj`）

`L2Metric` 增加**可选字段**（缺省为 `undefined`，旧渲染器/测试不感知即退化为旧行为）：

```ts
export interface L2Metric {
  key: 'span' | 'depth' | 'managerRatio' | 'vacancy';
  label: string;
  value: number | null;
  unit: string;
  status: HealthStatus;
  verdict: string;
  // —— v2.0.9 新增（可选）——
  spanBreakdown?: SpanBreakdown;      // key === 'span' 时
  depthBreakdown?: DepthBreakdown;    // key === 'depth' 时
  managerBreakdown?: ManagerBreakdown;// key === 'managerRatio' 时
}
```

- 三个 breakdown 由独立纯函数 `computeSpanBreakdown / computeDepthBreakdown / computeManagerBreakdown` 产出，`computeL2` 组装到对应指标上。
- `value`/`status`/`verdict` 字段语义：span 的 `value` 改中位数（**语义变化，测试需改**）；depth 的 `value` 仍是 max（**不变**）；managerRatio 的 `value` 改「内部负责人 ÷ 含管理者全员」（**语义变化，测试需改**）；vacancy 完全不变。
- **不新增 `HealthStatus` 枚举值**、**不改 `HealthThresholds` 结构**（阶段预设不动）。

### D.2 新增/修改的测试用例（每个失真点 ≥1 例，含边界）

| 指标 | 用例（新增或改） | 断言要点 |
| --- | --- | --- |
| span | 中位数稳健性：3 个有负责人部门直管 [2, 3, 40] → `span.value`(中位数)=3，`status` 按 3 判定；`max`=40 | 中位数不被 40 拉高 |
| span | 中间管理层直管：`研发部`(负责人) 下挂 3 个各有负责人的子部门、节点直挂 0 人 → `directReports=3`（旧口径=0） | 修正系统性低估 |
| span | 扁平退化：无子部门、节点直挂 4 人 → `directReports=4`（与旧口径一致） | 不回归 |
| span | 极值兜底：中位数健康但 `max > spanWarnMax` → 部门级建议把最宽部门标 critical | 单点失衡不抹平 |
| span | 边界：0 个有负责人部门 → `median=null`、`status=warn`、verdict 含「未设置部门负责人」 | 不可算分支 |
| span | 均值保留：`spanBreakdown.mean` 与旧 `span.value` 数值相等（回归对照） | 便于核对迁移 |
| depth | 分层：3 层组织里 1 条 6 层深链 → `max=6`、`p50` 与 `p90` 远小于 6、`deepestPath` 指向深链叶子 | 深链不再=全组织结论 |
| depth | 均匀深链：`chain(5)` 单链 → `p50=p90=max=5`（n=1 时三者相等） | 单链边界 |
| depth | 空树：`p50=p90=max=0`、`deepestPath=[]`、`deptCount=0`、verdict 仍含「无法评估层级」 | 空树分支 |
| depth | 整数分位：nearest-rank 使 p90 落在真实层数（无 3.7 层） | 分位算法 |
| managerRatio | 外部剔除：负责人 leaderId 不在员工名册 → 不计分子，`externalManagers=1`、`internalManagers=0` | 外部判定 |
| managerRatio | 内部计入：负责人作为员工（`employeeId` 匹配）→ 计入分子 | 内部判定 |
| managerRatio | 去重 bug：同一人 A 部门用 `leaderId`、B 部门用 `leaderName`（同姓名在名册内）→ 只算 1 | 统一 canonical key |
| managerRatio | 兼岗暴露：同一 key 兼任 2 部门 → `multiDeptManagers=1`、去重后分子仍 1 | 兼岗计数 |
| managerRatio | 分母辅助：`nonManagerEmployees = totalEmployees − internalManagers`，非管理者口径 = internal ÷ nonManager | 双口径 |
| managerRatio | 无员工：`totalEmployees=0` → `managerRatio=null`、verdict 含「无员工数据」 | 不可算分支 |
| 回归 | `.orgproj` 兼容：`ProjectFile` 序列化/反序列化（`src/utils/project.ts`）在改动前后一致（数据模型未变，仅补一条守卫测试） | 无破坏性变更 |

> 说明：`computeL2` 的 span/managerRatio 现有多条断言（均值、`leaderId` 在名册外）将因口径修正而失效，需在**同一 PR** 内同步改写，**不得**用「跳过测试」的方式合并。

### D.3 `.orgproj` 兼容性结论

**不破坏**。本方案零数据模型改动：`Department`/`Employee`/`Scenario`/`ProjectFile` 结构不变，新增的 breakdown 均为**运行时派生**（不进任何持久化结构）。`src/utils/project.ts` 的序列化/反序列化不需要动。唯一需补的是 D.2 末行的「改动前后 `.orgproj` 往返一致」守卫测试，作为回归护栏。

### D.4 同步更新 `METRIC_CALIBER_NOTES`（4 段口径文案）

现有文案（`analytics.ts` L563-568）需同步改写为（供 UI「?」与报告「口径与边界」复用）：

- **span**：`管理幅度 = 有负责人部门「直管人数」的中位数（直管 = 节点直挂员工 + 下一层有负责人子部门数）。中位数对极端值稳健；另展示最小/最大与部门级明细，最宽的部门单独标出。未设负责人的部门不参与；均值仅作参考。`
- **depth**：`层级深度 = 全组织最大层数（根 L1=1），同时给出 P50/P90 典型深度与最深链路的部门定位。最大层数只代表最坏链，不代表大多数部门；深链（零售/医院/教育）可能正是业务所需，别据此一律压层。`
- **managerRatio**：`管理者比 = 内部负责人数（去重、剔除不在员工名册内的外部负责人）÷ 员工总数（含管理者、不含虚拟兼岗）。兼岗/副职/挂名负责人暂无法用现有字段精确剔除，比值可能仍偏高，请结合实际情况解读；另附「非管理者口径」供对照。`
- **vacancy**：`空岗率 =（有效编制 − 实际）÷ 有效编制。只统计配置了编制的部门；编制未填时提示“无数据”而非视为健康。`（本段沿用，仅核对无改动）

### D.5 与其它任务的接口（供 Captain 汇总对齐）

- **与 t1（product-expert）**：本方案输出的「中位数 + 极值 + 分布」「P50/P90 + 最深链」「内部/外部/兼岗计数」就是场景差异比较与管理层报告里「指标差异」可复用的原子数据；报告里应引用这些 breakdown，而不是再算一遍。
- **与 t3（hr-expert）**：管理者比分母「保持含管理者全员」的决策，依赖 hr-expert 对阈值是否需重标定的确认；若 hr-expert 坚持改「非管理者分母」，则三档阶段阈值（`managerHealthyMax/managerWarnMax`）需同步重标定，属**新增范围**，需在路线图里显式立项。
- **v2.1.0 前置留痕**：「负责人类型」字段（专职/兼岗/副职/外部）是 C.4 残留失真的根治手段，已在本方案 §C.2/C.4 落点，供 `v210-position-model-design.md` 引用。

---

## 附：本方案引用的现有代码位置速查

| 对象 | 位置 |
| --- | --- |
| `computeL2`（span/managerRatio 现口径） | `analytics.ts` L433-542 |
| `computeTreeDepth` | `analytics.ts` L545-552 |
| 阈值分级 `spanStatus/depthStatus/managerRatioStatus` | `analytics.ts` L356-380 |
| `deptStatus`（`headcount===null → warn`，本版本不改） | `analytics.ts` L394-400 |
| `METRIC_CALIBER_NOTES` | `analytics.ts` L563-568 |
| `generateDeptSuggestions`（span 直管数口径需同步改） | `analytics.ts` L777-876 |
| `Employee.isVirtual`（兼岗虚拟员工，与负责人类型无关） | `types/index.ts` L12 |
| `Department.leaderId/leaderName/headcount` | `types/index.ts` L21-33 |
| 负责人从员工表选择（`employeeId` 对齐 leaderId） | `App.tsx` L250-251、`DepartmentCard.tsx` L271 |
| 现有单测（span/managerRatio 口径需同步改） | `analytics.test.ts` L116-175、L303-371 |
