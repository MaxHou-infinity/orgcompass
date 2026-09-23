# 测试夹具（fixtures）

## `excel/`

真实 Excel 样本，供 `src/utils/excel.integration.test.ts` 端到端解析用
（走与 App 相同的路径：`fs → Uint8Array → XLSX.read({type:'array'})`）。

| 文件 | 用途 |
|---|---|
| `test_employee_import.xlsx` | 员工信息表样本（10 人），验证建树、员工归属、岗位映射 |
| `test_org_import.xlsx` | 组织架构表样本，验证补充层合并与部门负责人 |

**为什么放在这里**：它们原本散落在仓库根目录（根目录曾同时有 4 个 `test_*.xlsx`）。
另外两个 `test_employees.xlsx` / `test_org.xlsx` **无任何引用**（v2.3.1 审计 T-14 已标记为死文件），
已于 v2.4.0 删除。

**路径解析**：测试用相对**测试文件**的绝对路径（`new URL('../../tests/fixtures/excel/', import.meta.url)`），
不依赖 vitest 的工作目录。

> 需要新的样本时，优先用应用内「文件上传 → 模板」下载的官方模板改造，
> 保证夹具与产品实际接受的格式一致。
