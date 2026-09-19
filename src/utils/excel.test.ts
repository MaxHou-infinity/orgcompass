import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildDepartmentTree,
  buildOrgExcelBytes,
  exportToExcel,
  buildSampleEmployeeTemplateBytes,
  buildSampleOrgTemplateBytes,
  buildSampleAssessmentTemplateBytes,
  generateSampleEmployeeTemplate,
  generateSampleOrgTemplate,
  mapEmployeeRows,
  mapPositionRows,
  mapAssessmentRows,
  resolveReportsToEmployeeIds,
  collectAllPositions,
  ExcelImportError,
} from './excel';
import { saveFile } from './tauri';

vi.mock('./tauri', () => ({
  saveFile: vi.fn().mockResolvedValue(true),
  isTauri: vi.fn().mockReturnValue(false),
}));

// 部分 mock xlsx：保留读取/生成能力，仅将 writeFile 替换为 spy，避免测试真实写文件
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('xlsx')>();
  return { ...actual, writeFile: vi.fn() };
});
import type { Employee, OrgTemplate, Department, CompetencyModel } from '../types';
import { DEFAULT_COMPETENCY_MODEL } from '../types';

/** 构造一个员工对象 */
function emp(partial: Partial<Employee> & { name: string; employeeId: string }): Employee {
  return {
    id: partial.employeeId,
    level: 'L1.1',
    dept1: '',
    dept2: '',
    dept3: '',
    dept4: '',
    dept5: '',
    dept6: '',
    ...partial,
  };
}

/** 查找指定名称的部门（递归） */
function findDept(depts: Department[], name: string): Department | undefined {
  for (const dept of depts) {
    if (dept.name === name) return dept;
    const found = findDept(dept.children, name);
    if (found) return found;
  }
  return undefined;
}

/** 收集某部门下（含自身）所有员工 */
function collectEmployees(dept: Department): Employee[] {
  return [...dept.employees, ...dept.children.flatMap(collectEmployees)];
}

describe('buildDepartmentTree', () => {
  it('空输入返回空数组', () => {
    expect(buildDepartmentTree([], [])).toEqual([]);
  });

  it('根据员工部门路径构建多级树并正确归属员工', () => {
    const employees: Employee[] = [
      emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发组', dept3: '后端' }),
      emp({ name: '李四', employeeId: 'E002', dept1: '技术部', dept2: '研发组', dept3: '后端' }),
      emp({ name: '王五', employeeId: 'E003', dept1: '技术部', dept2: '研发组', dept3: '前端' }),
    ];

    const tree = buildDepartmentTree(employees, []);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('技术部');
    expect(tree[0].level).toBe(1);

    const 研发组 = findDept(tree, '研发组');
    expect(研发组).toBeDefined();
    expect(研发组!.level).toBe(2);
    expect(研发组!.parentId).toBe(tree[0].id);

    const 后端 = findDept(tree, '后端');
    const 前端 = findDept(tree, '前端');
    expect(后端!.level).toBe(3);
    expect(前端!.level).toBe(3);
    expect(collectEmployees(后端!)).toHaveLength(2);
    expect(collectEmployees(前端!)).toHaveLength(1);
  });

  it('组织架构模板创建部门并设置负责人', () => {
    const employees: Employee[] = [
      emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发组' }),
    ];
    const templates: OrgTemplate[] = [
      { dept1: '技术部', dept2: '研发组', deptLevel: '2', leaderId: 'E001', leaderName: '张三' },
    ];

    const tree = buildDepartmentTree(employees, templates);
    const 研发组 = findDept(tree, '研发组');
    expect(研发组).toBeDefined();
    expect(研发组!.leaderId).toBe('E001');
    expect(研发组!.leaderName).toBe('张三');
  });

  it('模板缺层级时，员工路径会自动补齐部门并归属', () => {
    // 模板只定义了 技术部/研发组 两级；员工声称属于 技术部/研发组/后端（三级）
    const employees: Employee[] = [
      emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发组', dept3: '后端' }),
    ];
    const templates: OrgTemplate[] = [
      { dept1: '技术部', dept2: '研发组' },
    ];

    const tree = buildDepartmentTree(employees, templates);
    const 研发组 = findDept(tree, '研发组');
    expect(研发组).toBeDefined();
    // 后端部门会被自动补齐（模板没有但员工声称存在）
    const 后端 = findDept(tree, '后端');
    expect(后端).toBeDefined();
    expect(后端!.level).toBe(3);
    expect(collectEmployees(后端!)).toHaveLength(1);
  });

  it('路径前缀匹配优先：同名子部门不挂在匹配父级下时，归属到最深可匹配部门', () => {
    // 华东区 挂在 市场部 下；员工声称 销售部/华东区（销售部下无华东区）
    const employees: Employee[] = [
      emp({ name: '周九', employeeId: 'E007', dept1: '市场部', dept2: '华东区' }),
      emp({ name: '吴十', employeeId: 'E008', dept1: '销售部', dept2: '华东区' }),
    ];

    const tree = buildDepartmentTree(employees, []);
    // 吴十：路径匹配停在 销售部（其 children 无 华东区）
    const 销售部 = findDept(tree, '销售部');
    expect(销售部).toBeDefined();
    expect(销售部!.employees.map(e => e.employeeId)).toContain('E008');
    // 周九 归到 市场部/华东区
    const 华东区 = findDept(tree, '华东区');
    expect(华东区!.employees.map(e => e.employeeId)).toContain('E007');
  });

  it('部门按中文名称排序', () => {
    const employees: Employee[] = [
      emp({ name: 'a', employeeId: 'E1', dept1: '技术部' }),
      emp({ name: 'b', employeeId: 'E2', dept1: '销售部' }),
      emp({ name: 'c', employeeId: 'E3', dept1: '人力资源部' }),
    ];

    const tree = buildDepartmentTree(employees, []);
    const names = tree.map(d => d.name);
    // localeCompare('zh-CN') 按拼音排序：j(技术部) < r(人力资源部) < x(销售部)
    expect(names).toEqual(['技术部', '人力资源部', '销售部']);
  });

  it('同名同层级部门在模板与员工数据中复用同一节点', () => {
    const employees: Employee[] = [
      emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发组' }),
    ];
    const templates: OrgTemplate[] = [
      { dept1: '技术部', dept2: '研发组', deptLevel: '2', leaderId: 'E001', leaderName: '张三' },
      { dept1: '技术部', dept2: '测试组', deptLevel: '2' },
    ];

    const tree = buildDepartmentTree(employees, templates);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    // 技术部下应有 研发组、测试组
    expect(tree[0].children.map(c => c.name).sort()).toEqual(['研发组', '测试组'].sort());
  });

  it('虚拟员工保留 isVirtual 标记', () => {
    const employees: Employee[] = [
      emp({ name: '兼岗', employeeId: 'V001', dept1: '技术部', isVirtual: true }),
    ];

    const tree = buildDepartmentTree(employees, []);
    const 技术部 = tree[0];
    expect(技术部.employees[0].isVirtual).toBe(true);
  });
});

describe('buildOrgExcelBytes / exportToExcel', () => {
  beforeEach(() => {
    vi.mocked(XLSX.writeFile).mockClear();
    vi.mocked(saveFile).mockClear();
  });

  it('生成 Excel 字节数据（排除虚拟员工，不抛错）', async () => {
    const tree: Department[] = [{
      id: 'd1',
      name: '技术部',
      level: 1,
      children: [],
      employees: [
        emp({ name: '张三', employeeId: 'E001', dept1: '技术部' }),
        emp({ name: '兼岗', employeeId: 'V001', dept1: '技术部', isVirtual: true }),
      ],
      expanded: true,
      positions: [],
    }];
    const bytes = await buildOrgExcelBytes(tree);
    // xlsx 文件以 PK (zip) 魔数开头
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4B);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('exportToExcel 生成字节并调用 saveFile 保存', async () => {
    const tree: Department[] = [{
      id: 'd1',
      name: '技术部',
      level: 1,
      children: [],
      employees: [emp({ name: '张三', employeeId: 'E001', dept1: '技术部' })],
      expanded: true,
      positions: [],
    }];
    await exportToExcel(tree);
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith(
      '组织架构数据.xlsx',
      expect.any(Uint8Array),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});

describe('模板下载字节有效性', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  beforeEach(() => {
    vi.mocked(XLSX.writeFile).mockClear();
    vi.mocked(saveFile).mockClear();
  });

  it('buildSampleEmployeeTemplateBytes 返回有效 xlsx 字节并含「员工信息」表', async () => {
    const bytes = await buildSampleEmployeeTemplateBytes();
    // xlsx zip 魔数 PK
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4B);
    expect(bytes.length).toBeGreaterThan(500);

    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('员工信息');
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['员工信息']);
    expect(rows).toHaveLength(3);
    expect(rows[0]['姓名']).toBe('张三');
    expect(rows[0]['工号']).toBe('E001');
    expect(rows[0]['职级']).toBe('L3.2');
  });

  it('buildSampleOrgTemplateBytes 返回有效 xlsx 字节并含「组织架构」表', async () => {
    const bytes = await buildSampleOrgTemplateBytes();
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4B);
    expect(bytes.length).toBeGreaterThan(500);

    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('组织架构');
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['组织架构']);
    expect(rows).toHaveLength(4);
    expect(rows[0]['一级部门']).toBe('技术部');
    expect(rows[0]['部门级别']).toBe('3');
  });

  it('generateSampleEmployeeTemplate 调用 saveFile 保存员工模板', async () => {
    await generateSampleEmployeeTemplate();
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith('员工信息模板.xlsx', expect.any(Uint8Array), XLSX_MIME);
  });

  it('generateSampleOrgTemplate 调用 saveFile 保存组织模板', async () => {
    await generateSampleOrgTemplate();
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith('组织架构模板.xlsx', expect.any(Uint8Array), XLSX_MIME);
  });
});

describe('v2.1.1 富字段导入：员工表可选列 + 缺省降级', () => {
  it('mapEmployeeRows 解析成本/目标职级/直接上级工号/岗位名称', () => {
    const rows = [
      {
        '姓名': '张三', '工号': 'E001', '职级': 'L3.2', '一级部门': '技术部',
        '个人成本': '24000', '目标职级': 'L4.1', '直接上级工号': 'E002', '岗位名称': '前端工程师',
      },
    ];
    const [e] = mapEmployeeRows(rows);
    expect(e.cost).toBe(24000);
    expect(e.targetLevel).toBe('L4.1');
    // reportsTo 在行内留存（_reportsToId），由 resolveReportsToEmployeeIds 统一解析为内部 id
    expect((e as unknown as Record<string, unknown>)._reportsToId).toBe('E002');
    // _positionName 为瞬态字段，运行时存在但不在类型上
    expect((e as unknown as Record<string, unknown>)._positionName).toBe('前端工程师');
  });

  it('缺省降级：无富字段列 → cost/targetLevel/reportsTo/岗位 均 undefined（不填 0）', () => {
    const rows = [
      { '姓名': '李四', '工号': 'E002', '职级': 'L2.1', '一级部门': '技术部' },
    ];
    const [e] = mapEmployeeRows(rows);
    expect(e.cost).toBeUndefined();
    expect(e.targetLevel).toBeUndefined();
    expect(e.reportsToEmployeeId).toBeUndefined();
    expect((e as unknown as Record<string, unknown>)._positionName).toBeUndefined();
  });

  it('个人成本非数字或空 → undefined（不落 0）', () => {
    const [a] = mapEmployeeRows([{ '姓名': 'A', '工号': 'E1', '一级部门': '技术部', '个人成本': '' }]);
    const [b] = mapEmployeeRows([{ '姓名': 'B', '工号': 'E2', '一级部门': '技术部', '个人成本': 'abc' }]);
    expect(a.cost).toBeUndefined();
    expect(b.cost).toBeUndefined();
  });

  it('resolveReportsToEmployeeIds 按姓名兜底匹配直接上级（解析为内部 id）', () => {
    const [e1] = mapEmployeeRows([{ '姓名': '张三', '工号': 'E001', '一级部门': '技术部' }]);
    const [e2] = mapEmployeeRows([{ '姓名': '王五', '工号': 'E003', '一级部门': '销售部', '直接上级': '张三' }]);
    const resolved = resolveReportsToEmployeeIds([e1, e2]);
    expect(resolved[1].reportsToEmployeeId).toBe(e1.id);
  });
});

describe('v2.1.1 富字段导入：建树 + 套岗', () => {
  it('员工岗位名称 → 部门下 find-or-create 岗位并套岗', () => {
    const employees = mapEmployeeRows([
      { '姓名': '张三', '工号': 'E001', '职级': 'L3.2', '一级部门': '技术部', '岗位名称': '前端工程师' },
      { '姓名': '李四', '工号': 'E002', '职级': 'L2.1', '一级部门': '技术部', '岗位名称': '前端工程师' },
      { '姓名': '王五', '工号': 'E003', '职级': 'L4.2', '一级部门': '技术部', '岗位名称': '研发经理' },
    ]);
    const tree = buildDepartmentTree(employees, []);
    const 技术部 = tree[0];
    // v2.3.1（T-08）：Department.positions 为可选字段，先取本地列表再断言（断言强度不变）。
    const positions = 技术部.positions ?? [];
    // 每个部门 positions 非空且被三个岗位填充
    expect(positions).toHaveLength(2);
    // 主路径无编制列 → headcount=0（编制未配置，不伪装满编；match 按 headcount<=0 不判超编）
    const 前端 = positions.find((p) => p.name === '前端工程师');
    const 经理 = positions.find((p) => p.name === '研发经理');
    expect(前端!.headcount).toBe(0);
    expect(经理!.headcount).toBe(0);
    // 员工已套岗到对应岗位
    expect(技术部.employees.find((e) => e.employeeId === 'E001')!.positionId).toBe(前端!.id);
    expect(技术部.employees.find((e) => e.employeeId === 'E002')!.positionId).toBe(前端!.id);
    expect(技术部.employees.find((e) => e.employeeId === 'E003')!.positionId).toBe(经理!.id);
  });

  it('岗位表先行（positionRows）：员工套岗「只查不建」，未匹配岗位保持未套岗', () => {
    const employees = mapEmployeeRows([
      { '姓名': '张三', '工号': 'E001', '一级部门': '技术部', '岗位名称': '前端工程师' },
      { '姓名': '李四', '工号': 'E002', '一级部门': '技术部', '岗位名称': '不存在岗位' },
    ]);
    const positionRows = mapPositionRows([
      { '一级部门': '技术部', '岗位名称': '前端工程师', '编制数': 3, '序列': '技术' },
    ]);
    const tree = buildDepartmentTree(employees, [], positionRows);
    const 技术部 = tree[0];
    const positions = 技术部.positions ?? [];
    // 岗位表先建岗，编制=3
    expect(positions).toHaveLength(1);
    expect(positions[0].headcount).toBe(3);
    expect(positions[0].jobFamily).toBe('技术');
    // 匹配到岗位表的员工套岗；未匹配的保持未套岗（不新建）
    expect(技术部.employees.find((e) => e.employeeId === 'E001')!.positionId).toBe(positions[0].id);
    expect(技术部.employees.find((e) => e.employeeId === 'E002')!.positionId).toBeUndefined();
  });

  it('collectAllPositions 扁平收集所有部门岗位', () => {
    const employees = mapEmployeeRows([
      { '姓名': '张三', '工号': 'E001', '一级部门': '技术部', '岗位名称': '前端工程师' },
      { '姓名': '王五', '工号': 'E003', '一级部门': '销售部', '岗位名称': '销售经理' },
    ]);
    const tree = buildDepartmentTree(employees, []);
    const all = collectAllPositions(tree);
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.name).sort()).toEqual(['前端工程师', '销售经理'].sort());
  });
});

describe('v2.1.1 岗位表 sheet：mapPositionRows', () => {
  it('映射部门路径/岗位名称/序列/职级带宽/编制数', () => {
    const rows = [
      { '一级部门': '技术部', '二级部门': '研发组', '岗位名称': '前端工程师', '序列': '技术', '职级带宽下限': 'L1', '职级带宽上限': 'L3.2', '编制数': 5 },
    ];
    const [p] = mapPositionRows(rows);
    expect(p.deptPath).toEqual(['技术部', '研发组']);
    expect(p.name).toBe('前端工程师');
    expect(p.jobFamily).toBe('技术');
    expect(p.levelBandMin).toBe('L1');
    expect(p.levelBandMax).toBe('L3.2');
    expect(p.headcount).toBe(5);
  });

  it('编制数缺省为 0；空字符串/非数字不报错', () => {
    const rows = [
      { '一级部门': '技术部', '岗位名称': 'A', '编制数': '' },
      { '一级部门': '技术部', '岗位名称': 'B' },
    ];
    const res = mapPositionRows(rows);
    expect(res[0].headcount).toBe(0);
    expect(res[1].headcount).toBe(0);
  });

  it('同名岗位去重：同一部门重复同名 → 抛 invalid-structure（不静默吞）', () => {
    const rows = [
      { '一级部门': '技术部', '岗位名称': '前端工程师', '编制数': 1 },
      { '一级部门': '技术部', '岗位名称': '前端工程师', '编制数': 2 },
    ];
    expect(() => mapPositionRows(rows)).toThrow(/同名岗位/);
  });

  it('不同部门可同名（不误判冲突）', () => {
    const rows = [
      { '一级部门': '技术部', '岗位名称': '经理' },
      { '一级部门': '销售部', '岗位名称': '经理' },
    ];
    expect(mapPositionRows(rows)).toHaveLength(2);
  });
});

describe('v2.2.0 胜任度评分导入：mapAssessmentRows', () => {
  it('正常映射：工号 → employeeKey、维度 label → key、评分人/日期/备注', () => {
    const rows = [
      {
        '工号': 'E001', '姓名': '张三',
        '战略解码': 4, '带队育人': 3, '结果担当': '', '协同影响': 4,
        '业务能力': 4, '单兵能力': 3,
        '评分人': '王五', '评估日期': '2026-01-10', '备注': '行为锚点引用',
      },
    ];
    const [r] = mapAssessmentRows(rows, DEFAULT_COMPETENCY_MODEL);
    expect(r.employeeKey).toBe('E001');
    expect(r.scores).toEqual({
      'leadership_strategy': 4,
      'leadership_team': 3,
      'leadership_collab': 4,
      'business': 4,
      'individual': 3,
    });
    expect(r.assessorName).toBe('王五');
    expect(r.assessedAt).toBe('2026-01-10');
    expect(r.note).toBe('行为锚点引用');
  });

  it('未填维度列（未评）不出现于 scores；评分人/日期/备注缺省不落字段', () => {
    const [r] = mapAssessmentRows([{ '工号': 'E002', '业务能力': 3 }], DEFAULT_COMPETENCY_MODEL);
    expect(r.scores).toEqual({ 'business': 3 });
    expect(r.assessorName).toBeUndefined();
    expect(r.assessedAt).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  it('员工标识缺省回退姓名（工号为空时）', () => {
    const [r] = mapAssessmentRows([{ '姓名': '李四', '业务能力': 3 }], DEFAULT_COMPETENCY_MODEL);
    expect(r.employeeKey).toBe('李四');
  });

  it('维度分越界/非整数/非数字 → 抛 ExcelImportError（invalid-structure），报错不静默', () => {
    for (const bad of [6, 0, 2.5, 'abc']) {
      expect(() =>
        mapAssessmentRows([{ '工号': 'E001', '业务能力': bad }], DEFAULT_COMPETENCY_MODEL),
      ).toThrow(ExcelImportError);
    }
    expect(() =>
      mapAssessmentRows([{ '工号': 'E001', '业务能力': 7 }], DEFAULT_COMPETENCY_MODEL),
    ).toThrow(/1–5/);
  });

  it('未知员工标识（工号与姓名均为空）→ 抛 ExcelImportError', () => {
    expect(() =>
      mapAssessmentRows([{ '工号': '', '姓名': '', '业务能力': 3 }], DEFAULT_COMPETENCY_MODEL),
    ).toThrow(/缺少员工标识/);
  });

  it('未知维度列 → 抛 ExcelImportError（invalid-structure），不静默吞', () => {
    expect(() =>
      mapAssessmentRows([{ '工号': 'E001', '部门': '技术部', '业务能力': 3 }], DEFAULT_COMPETENCY_MODEL),
    ).toThrow(/未知列/);
    // 停用维度（enabled:false）不是评分列 → 同样报错
    const modelWithDisabled: CompetencyModel = {
      dimensions: [
        { key: 'business', label: '业务能力', definition: 'd', weight: 1, group: 'staff', order: 1, enabled: true },
        { key: 'old_dim', label: '停用维度', definition: 'd', weight: 1, group: 'staff', order: 2, enabled: false },
      ],
    };
    expect(() =>
      mapAssessmentRows([{ '工号': 'E001', '停用维度': 3 }], modelWithDisabled),
    ).toThrow(/未知列/);
  });

  it('模板维度列随 model 动态生成：enabled 维度为列头，停用维度不生成，且模板可回读导入', async () => {
    const model: CompetencyModel = {
      dimensions: [
        { key: 'business', label: '业务能力', definition: '岗位专业深度', weight: 1, group: 'staff', order: 1, enabled: true },
        { key: 'individual', label: '单兵能力', definition: '自驱协作', weight: 1, group: 'staff', order: 2, enabled: true },
        { key: 'old_dim', label: '停用维度', definition: 'd', weight: 1, group: 'staff', order: 3, enabled: false },
      ],
    };
    const bytes = await buildSampleAssessmentTemplateBytes(model);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4B);
    expect(bytes.length).toBeGreaterThan(500);

    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('胜任度评分');
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['胜任度评分']);
    expect(rows).toHaveLength(1);
    const headerKeys = Object.keys(rows[0]);
    expect(headerKeys).toContain('工号');
    expect(headerKeys).toContain('姓名');
    expect(headerKeys).toContain('业务能力');
    expect(headerKeys).toContain('单兵能力');
    expect(headerKeys).toContain('评分人');
    expect(headerKeys).toContain('评估日期');
    expect(headerKeys).toContain('备注');
    expect(headerKeys).not.toContain('停用维度');

    // 模板行可直接回读导入（往返一致）
    const mapped = mapAssessmentRows(rows, model);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].scores).toEqual({ 'business': 3, 'individual': 3 });
  });
});
