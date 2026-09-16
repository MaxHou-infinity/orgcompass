<div align="center">

![组织罗盘 OrgCompass：从组织架构设计到组织健康诊断](docs/assets/readme/social-preview.png)

# 组织罗盘 · OrgCompass

**从画组织架构，到看懂组织问题。**<br>一款面向 HRBP / 组织发展（OD）的本地优先组织设计与健康诊断工作台。

[![Latest release](https://img.shields.io/github/v/release/MaxHou-infinity/orgcompass?display_name=tag&label=release&color=6d5dfc)](https://github.com/MaxHou-infinity/orgcompass/releases/latest) [![License](https://img.shields.io/github/license/MaxHou-infinity/orgcompass?color=2563eb)](LICENSE) ![Platforms](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon%20%7C%20Windows-334155) ![Local first](https://img.shields.io/badge/data-local--first-16a34a)

**[下载最新版](https://github.com/MaxHou-infinity/orgcompass/releases/latest)** · **[查看功能](#核心能力)** · **[了解诊断口径](#诊断如何工作)** · **[反馈问题](https://github.com/MaxHou-infinity/orgcompass/issues/new/choose)**

</div>

---

## 30 秒了解 OrgCompass

很多组织架构工具停在“把框画出来”。OrgCompass 继续往前一步：把组织数据变成可检查、可推演、可交付的决策材料。

![OrgCompass 工作流：导入、建模、诊断、推演、输出](docs/assets/readme/workflow.svg)

| 你正在解决的问题 | OrgCompass 给出的结果 |
| --- | --- |
| 组织调整前，方案只存在于脑中 | 保存基线、方案 A、方案 B，分别推演组织结构 |
| 管理层级、管理幅度靠人工逐个数 | 自动计算并用红 / 黄 / 绿状态提示异常 |
| 编制、实际人数和招聘缺口分散在表格里 | 按部门汇总编制、实际、空岗 / 超编和职级成本 |
| 组织图画完后仍要手工整理汇报材料 | 导出组织图、Excel 和包含建议的诊断报告 |

> OrgCompass 的目标不是替 HRBP 做判断，而是把判断所需的结构、指标和差异摆到同一张工作台上。

---

## 真实产品界面

![OrgCompass 组织健康度面板：管理幅度、层级深度、管理者比与空岗率](docs/assets/readme/product-health.png)

上图为真实运行界面。健康度面板会根据当前场景实时计算指标，标记需要关注的部门，并把异常项转化为可追溯的优化建议。

---

## 核心能力

### 1. 设计组织，而不只是画组织图

- L1–L6 多级部门树与清晰的父子引导线
- 拖拽部门调整层级，拖拽或框选批量移动员工
- 部门负责人、岗位、职级、编制和成本信息同图呈现
- 搜索定位、撤销 / 重做、触控板缩放与画布平移
- 兼岗人员、未入架构员工和负责人选择

### 2. 看见组织健康度

- 管理幅度、层级深度、管理者比、空岗率四项核心指标
- 红 / 黄 / 绿状态判读与整体诊断
- 编制 vs 实际 vs 缺口，联动职级成本
- 根据指标和部门异常生成规则化建议
- 阈值可按企业阶段和管理口径调整，并保存在本地

### 3. 推演方案，而不是覆盖原方案

- 基线、方案 A、方案 B 等多个场景快照
- 自动保存与撤销 / 重做
- `.orgproj` 项目文件保存、打开和换机备份
- 在同一份组织数据上尝试不同汇报线和人员安排

### 4. 从数据输入到报告输出

- 导入员工 Excel 与组织架构 Excel
- 互联网科技、制造业、零售连锁、医院科层、教育服务模板
- 导出 PNG、Excel 和组织诊断报告
- Web 与 Tauri 桌面端共用同一套数据模型

---

## 适合哪些工作场景

| 场景 | 典型问题 | 推荐用法 |
| --- | --- | --- |
| 组织调整 | 新旧方案差异难以讲清 | 保存基线并建立多个场景，分别调整部门与汇报线 |
| 年度编制规划 | 编制、缺口、成本来回对表 | 导入员工数据，补齐部门编制和职级成本，查看缺口汇总 |
| 组织健康体检 | 不知道哪里层级过深、管理幅度异常 | 打开健康度面板，按红黄绿状态定位部门和指标 |
| 招聘协同 | 招聘需求缺少组织上下文 | 用部门缺口和成本信息形成更清晰的需求依据 |
| 管理层汇报 | 组织图与诊断结论分散 | 导出组织图、明细表和诊断报告作为讨论底稿 |

---

## 诊断如何工作

OrgCompass 当前使用透明、可配置的规则口径，不使用不可解释的“黑盒评分”。

| 指标 | 当前计算口径 | 默认健康区间 |
| --- | --- | --- |
| 管理幅度 | 有负责人部门「直管人数」的中位数（直管 = 直属员工 + 下一层有负责人子部门数）；单点极宽会单独标出 | 3–8 人 |
| 层级深度 | 部门节点深度分布的 P90（根 L1=1），同时展示最大层数与最深链路；孤立深链触发关注、超硬上限触发预警 | 不超过 4 层 |
| 管理者比 | 内部负责人数（去重、剔除不在员工名册内的外部负责人）÷ 员工总数 | 不超过 15% |
| 空岗率 | （有效编制数 − 实际人数）÷ 有效编制数 | 不超过 10% |

- 阈值可以在健康度面板中调整，默认值只是通用起点。
- 未设置负责人、编制或员工数据时，系统会说明无法计算的原因，不把缺失数据伪装成健康结论。
- 优化建议由异常指标与部门数据触发，数量随当前组织情况变化。

### 胜任度与缺口清单口径

| 项目 | 当前计算口径 |
| --- | --- |
| 评价完整度 | 应评维度 = 当前分类（干部 / 员工）下启用的模型维度；完整度 = 有效已评维度 ÷ 应评维度。**部分已评即使已评维度全绿也不算完整达标** |
| 能力灯号 | 最差维度 Gap（木桶）：≤0 绿 / =1 黄 / ≥2 红；权重只影响总分，不影响灯号 |
| 岗位适用性 | 优先使用绑定当前任职的岗位评价；旧记录仅在能唯一对上当前任职时可用，否则标为「历史岗位评价，适用性待复核」，不自动成为新岗位结论 |
| 同日修订 | 同一人 / 范围 / 维度 / 角色 / 评估时点内按修订链取终点；旧分保留；内容冲突且无修订关系时标记「评分冲突待核对」，不按顺序任选 |
| HRBP 校准 | 与上级原始分并列呈现，不参与原始灯号与完整度分子 |
| 待补 / 超额 | 待补 = max(编制 − 主岗占用, 0)，超额 = max(主岗占用 − 编制, 0)；两者分别求和，净额只作补充 |
| 缺口成本 | 单位万元/月；依据顺序：岗位职级带宽 → 在岗目标职级成本均值 → 在岗实际成本均值；找不到依据时留空并标「无法估算」，不写成 0 |

> **使用边界：** 指标用于发现值得讨论的结构性信号，不替代业务背景、人才判断、劳动关系和管理责任。
> 胜任度与复核只呈现可追溯依据，不自动定级、晋升或淘汰；岗位缺口清单是编制缺口事实，不是已批准招聘需求。

---

## 下载与运行

### 普通用户：下载桌面版

前往 **[Latest Release](https://github.com/MaxHou-infinity/orgcompass/releases/latest)**，根据系统选择安装包：

| 系统 | 支持范围 | 推荐文件 |
| --- | --- | --- |
| macOS | Apple Silicon（arm64） | `OrgCompass_*_aarch64.dmg` |
| Windows | 64 位（x64） | `OrgCompass_*_x64-setup.exe` |
| Windows 管理部署 | 64 位（x64） | `OrgCompass_*_x64_en-US.msi` |

当前版本不提供 Intel Mac 与 Linux 安装包。v2.0.5 及以前的历史 Release 可能仍包含旧平台资产。

### 开发者：运行 Web 版

Web 版目前提供源码运行与自行部署，不代表已有公开在线服务。

> 前置要求：**Node `^20.19.0` 或 `>=22.12.0`**（Vite 8 的最低要求）。

```bash
git clone https://github.com/MaxHou-infinity/orgcompass.git
cd orgcompass
npm ci
npm run dev
```

构建静态 Web 产物：

```bash
npm run build
npm run preview
```

### 开发者：运行 Tauri 桌面版

macOS 需要 Xcode Command Line Tools 与 Rust；Windows 需要 WebView2 与 Rust。

```bash
npm run tauri:dev
npm run tauri:build
```

---

## 数据与隐私

OrgCompass 采用本地优先设计：

- 不需要账号或业务服务器即可运行
- 当前版本不包含云端同步、组织数据上传或遥测服务
- Web 版自动保存到浏览器本地存储
- 桌面版可通过 `.orgproj` 文件备份和迁移项目
- Excel、组织结构与诊断计算均在本机完成

组织和人员数据通常具有敏感性。请使用企业认可的设备与文件存储方式，并妥善管理导出的图片、Excel、报告和项目备份。

---

## Roadmap

路线图表达产品方向，不等同于具体版本或发布日期承诺。

### Now · 让组织诊断更容易落地

- 更清晰的数据导入校验与错误解释
- 更直观的场景差异比较与管理层报告
- 更可靠的安装、升级和示例体验

### Next · 从组织树深入岗位与编制

- 组织—岗位—编制—人员的完整视图
- 可复用的行业 / 企业阶段诊断基准
- 面向招聘 BP 的岗位缺口与成本视图

### Exploring · 人岗匹配与排兵布阵

- 干部与员工胜任度的可视化表达
- 评分依据、差距与结论的可追溯设计
- 权限、隐私、评价偏差与人工复核机制

### v2.0.8 工程重点

下一版本会先处理依赖安全与发布稳定性，再继续扩展产品能力。详细的验收条件与问题记录见 [v2.0.8 开发路线图](docs/v208-roadmap.md)。

- P0：处理 `xlsx` 运行时高危依赖，或形成明确的风险例外
- P1：完成 Tailwind 4 迁移评估，解决当前 PostCSS 构建阻塞
- P1：完成 Vite 8 / React 插件 6 的 macOS 与 Windows Tauri 打包验证

欢迎通过 [Issues](https://github.com/MaxHou-infinity/orgcompass/issues/new/choose) 提交场景、问题和建议。

---

## 技术与质量

React 18 · TypeScript strict · Vite 8 · Tailwind CSS 4 · dnd-kit · Tauri 2 · Rust · xlsx · html2canvas · Vitest

```bash
npm run lint
npm run test
npm run build
```

目录结构：

```text
├── src/                 # React 应用、组件、分析逻辑与测试
├── src-tauri/           # Tauri 桌面端与 Rust 配置
├── docs/                # 设计记录与 README 视觉资产
└── .github/workflows/   # 多平台 Release 构建
```

---

## 许可证

[Apache License 2.0](LICENSE) © 2026 [Max Hou](https://github.com/MaxHou-infinity)

允许商用、修改和分发；请按许可证要求保留版权与许可证声明，并标注修改。

<details>
<summary>品牌与历史安装包兼容说明</summary>

项目已由 `OrgStructureDesigner` 升级为 **组织罗盘 OrgCompass**。v2.0.4 及以前的安装包仍使用旧文件名前缀；自 v2.0.5 起使用 `OrgCompass_*`。历史安装包名称不同不影响其对应版本功能。

</details>
