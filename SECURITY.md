# 安全与隐私报告

OrgCompass 会处理组织、岗位、编制和人员信息。这类数据可能具有敏感性，请不要在公开 Issue、截图或附件中提交真实员工数据。

## 报告安全问题

如果问题可能涉及以下情况，请使用 GitHub 的私密安全报告渠道：

- 本地文件、Excel 或 `.orgproj` 数据意外泄露
- 任意文件读取 / 写入、路径穿越或权限绕过
- 依赖漏洞对 OrgCompass 的实际影响
- 安装包、Release 资产或更新链路完整性问题
- 其他不适合公开披露的安全或隐私风险

请前往仓库的 Security 页面，并选择 **Report a vulnerability**：

<https://github.com/MaxHou-infinity/orgcompass/security>

仓库上线本文件时，应同步开启 GitHub Private vulnerability reporting；如果页面暂未显示私密报告入口，请不要把漏洞细节提交到公开 Issue。

报告时建议包含：

1. 受影响版本与操作系统
2. 最小复现步骤
3. 预期影响与实际影响
4. 已匿名化的日志或示例数据

## 依赖与供应链安全

- `xlsx`（SheetJS 社区版）通过官方 CDN tarball 锁定修复版（`https://cdn.sheetjs.com/xlsx-0.20.x/xlsx-0.20.x.tgz`），以命中原型污染与正则 DoS 两个已公开高危 CVE。该来源非 npm registry，CI 已用 `npm audit --omit=dev --audit-level=high` 作为门禁。
- **边界声明（v2.3.1 补充）**：`npm audit` 的 advisory 库**不覆盖 URL 依赖**，因此该门禁对 `xlsx` 本身不生效；这条依赖的可信度来自 `package-lock.json` 中记录的 `integrity` 哈希（供应链来源可控但不在 advisory 覆盖范围内）。若目标环境无法访问该 CDN，需评估受控 fork 或替代方案，并在发布说明中披露供应链来源。
- Dependabot alerts / security updates 保持开启，PR 专用 CI 对运行时依赖高危项做零容忍。
- **逐版本重核要求**：依赖与告警状态必须在**每个发布版本**重新核验，不得复用历史「安全通过」结论（v2.2.1 曾出现结论跨版本沿用的情况）。

### 已知并登记的依赖告警（暂缓处理，非隐藏）

- **`glib`（Rust，`src-tauri/Cargo.lock`，中危）** — “glib::VariantStrIter 的 `Iterator`/`DoubleEndedIterator` 实现存在 Unsoundness”。
  - **为何暂缓**：`glib` 属于 **Linux / GObject 依赖链**（经 Tauri 的 gtk / webkit2gtk），而本项目发布目标为 **macOS(Apple Silicon) + Windows**，这两端 Tauri 使用原生 WKWebView / WebView2，**不链接 glib**，故该告警不影响已发布安装包；且为**中危 + 极窄使用面**的缺陷。
  - **处置**：登记为已知项，待未来做 Rust 依赖整体升级或重新引入 Linux 目标时，用一次受控的 `cargo update` 将 `glib` 提升到 ≥0.20.0 一并解决。
  - **结论**：该风险不构成发布阻塞，登记不掩盖。（结论面向 **v2.3.1**；v2.3.1 未重新执行 `cargo audit`，该结论沿用「macOS / Windows 目标不链接 glib」的实证，**下一次 Rust 依赖变更前需重做一次受控核查**。）

## 被忽略的依赖类别（明确登记，不冒充「零告警」）

| 类别 | 当前状态 | 说明 |
| --- | --- | --- |
| 生产 npm 依赖 | 高危 = 0 | CI 门禁 `npm audit --omit=dev --audit-level=high` |
| URL 依赖（`xlsx`） | 不在 advisory 覆盖内 | 由 lockfile `integrity` 哈希保证来源 |
| 开发 npm 依赖 | 3 条告警（构建工具链） | 不进入发布产物；升级需单独验证，未见「零告警」声明 |
| Rust / Cargo | 未做受控 `cargo audit` | 见上文 `glib` 登记项 |

## 数据最小化

- 不要上传真实姓名、邮箱、工号、薪酬、评价或组织机密。
- 如需提供复现文件，请使用虚构人员和最小字段集。
- 请先移除截图中的个人信息、文件路径和公司名称。

公开的普通 Bug 和功能建议请使用 [Issue 模板](https://github.com/MaxHou-infinity/orgcompass/issues/new/choose)。
