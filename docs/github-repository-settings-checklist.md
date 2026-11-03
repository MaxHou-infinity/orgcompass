# OrgCompass GitHub 仓库设置优化清单

> 用途：记录执行前状态、目标配置与上线后的回查标准。
>
> 审计与授权日期：2026-08-27
>
> 仓库：<https://github.com/MaxHou-infinity/orgcompass>

## 1. 当前公开状态

| 设置项 | 当前状态 | 判断 |
| --- | --- | --- |
| Description | 英文描述，已能表达组织设计与健康分析 | 基础合格，但对中文 HRBP / OD 的搜索覆盖不足 |
| Homepage | 空 | 暂无公开 Demo 或产品落地页，不应填写占位地址 |
| Social Preview | GitHub 默认图 | 无法传达品牌、目标用户与差异化价值 |
| Topics | 10 个，包含 React / TypeScript / Vite 等技术标签 | 技术标签偏多，领域检索词不足 |
| Issues | 已开启，无历史 Issue | 需要结构化模板和隐私提示 |
| Discussions | 关闭 | 在没有持续运营能力前保持关闭 |
| Wiki / Projects | 已开启 | README 尚未使用它们承载用户旅程；是否关闭需另行判断 |
| Community health | 42% | 缺 SECURITY、Issue / PR 社区文件等 |
| `main` 保护 | 未保护，无 Ruleset | 存在误删和强推风险 |
| Dependabot alerts | 关闭 | 依赖风险缺少持续提醒 |
| Dependabot security updates | 关闭 | 已知安全升级不会自动提议 |
| Secret scanning | 已开启 | 保持 |
| Secret scanning push protection | 已开启 | 保持 |
| Private vulnerability reporting | 关闭 | `SECURITY.md` 的私密报告入口上线前必须启用 |
| GitHub Pages | 未启用 | 没有公开 Web Demo 前保持关闭 |

## 2. 本次授权执行的设置

这些变更不涉及产品代码。仓库所有者已于 2026-08-27 确认按本清单范围执行；最终状态以第 5 节的线上回查结果为准。

### 2.1 About / Description

建议值：

```text
Local-first organization design & health analysis for HRBP/OD｜组织架构、编制成本、健康诊断与方案推演
```

判断逻辑：保留英文发现能力，同时让中文目标用户在仓库首屏直接看到用途。

### 2.2 Topics

建议保留 / 新增：

```text
org-chart
org-health
organization-design
organizational-development
hrbp
hr-tech
human-resources
workforce-planning
headcount-planning
span-of-control
local-first
desktop-app
tauri
data-visualization
```

建议移除：

```text
react
typescript
vite
```

判断逻辑：Topics 优先服务用户问题和领域搜索；技术栈已在 README 中表达。

### 2.3 Social Preview

上传文件：

```text
docs/assets/readme/social-preview.png
```

规格：1280 × 640 PNG，2:1。包含品牌、目标用户、核心价值和真实产品截图。

### 2.4 Security

建议开启：

1. Dependabot alerts
2. Dependabot security updates
3. Private vulnerability reporting

保持开启：

1. Secret scanning
2. Secret scanning push protection

Private vulnerability reporting 应与 `SECURITY.md` 同时上线，避免公开文档指向未启用的私密报告入口。

### 2.5 `main` 最小 Ruleset

建议规则：

- 阻止删除 `main`
- 阻止 force push
- 不强制 Pull Request
- 不强制审批人数
- 暂不设置 required status checks（当前 CI 只在 Tag / 手动触发时运行）

判断逻辑：适配单人维护，不阻断当前直接提交方式，同时避免不可恢复的 Git 历史破坏。

## 2.6 公开演示对应的 Homepage

仓库 About → Website 填这一串，且只填这一串：

`https://compass.hiontic.com`

这项在 GitHub 设置里修改，提交改不了。不要改用 GitHub Pages 来托管演示。

## 3. 暂不建议执行

| 设置项 | 建议 | 原因 |
| --- | --- | --- |
| GitHub Pages | 不启用 | 公开演示走 Cloudflare Pages 项目 `orgcompass` 的 Direct Upload，不用 GitHub Pages |
| Discussions | 保持关闭 | 空论坛会增加维护负担和冷清感 |
| Wiki / Projects | 暂不改 | 需要先确认是否已有私下使用方式 |
| 强制 PR | 不启用 | 对当前单人维护成本过高 |
| 自动合并 | 不启用 | 当前没有稳定的 PR CI 门禁 |
| CodeQL | 作为后续项 | 先完成依赖提醒、私密报告与日常 CI |

## 4. 需要通过提交上线的仓库门面文件

本次仓库门面提交包含：

```text
README.md
SECURITY.md
.github/ISSUE_TEMPLATE/config.yml
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/ISSUE_TEMPLATE/data_import.yml
docs/assets/readme/orgcompass-brand-background.png
docs/assets/readme/product-health.png
docs/assets/readme/social-preview.png
docs/assets/readme/social-preview.svg
docs/assets/readme/workflow.svg
docs/github-repository-settings-checklist.md
```

建议提交信息：

```text
docs: rebuild README and repository presentation
```

## 5. 线上执行后的验证清单

- 仓库首页首屏能看到新版 Hero、徽章和下载入口
- `releases/latest` 可到达当前正式版
- 工作流 SVG 和产品截图在 GitHub README 中正常显示
- Issue 入口出现 Bug、功能建议、数据导入三类模板
- 安全问题入口跳转到私密漏洞报告，而不是公开 Issue
- 分享仓库链接时使用自定义 Social Preview
- About Description 与 Topics 显示新值
- Security 页面显示 Dependabot alerts / security updates 已启用
- `main` 不能被删除或强推，普通直接 Push 仍可用

## 6. 本次明确不执行

- 不修改 `src/`、`src-tauri/` 或产品逻辑
- 不修改安装包、Release、Tag 或版本号
- 不部署 Web Demo
- 不创建 GitHub Release
- 不修改 Homepage、Wiki、Projects 或 Discussions
- 不启用强制 Pull Request 或强制审批
