import { Employee, Department, OrgTemplate, Position } from '../types';
import { buildDepartmentTree } from './excel';
import { deriveManagementLoads } from './management';
import { uid } from './project';

/**
 * 内置行业模板（v2.0.3 P1-4）。
 * 预置 5 套、各 30 人的合成组织，经左侧示例入口载入（互联网/制造/零售/医院/教育）。
 * 数据以员工路径 + 组织模板表示，经 buildDepartmentTree 复用同一套建树逻辑，保证口径一致。
 */

export interface IndustryTemplate {
  id: string;
  name: string;
  description: string;
  /** 展示用主色 */
  accent: string;
  /** 图标（lucide 名，简化处理） */
  icon: string;
  employees: Employee[];
  orgTemplates: OrgTemplate[];
}

function titleForLevel(level: string): string {
  const n = Number.parseFloat(level.replace(/^[A-Za-z]+/, '')) || 0;
  if (n >= 5) return '总监';
  if (n >= 4) return '经理';
  if (n >= 3) return '主管';
  return '专员';
}

function emp(id: string, name: string, employeeId: string, level: string, depts: string[]): Employee {
  return {
    id,
    name,
    employeeId,
    level,
    title: titleForLevel(level),
    dept1: depts[0] || '',
    dept2: depts[1] || '',
    dept3: depts[2] || '',
    dept4: depts[3] || '',
    dept5: depts[4] || '',
    dept6: depts[5] || '',
  };
}

function org(def: { depts: string[]; deptLevel?: string; leaderId?: string; leaderName?: string }): OrgTemplate {
  return {
    dept1: def.depts[0] || '',
    dept2: def.depts[1] || '',
    dept3: def.depts[2] || '',
    dept4: def.depts[3] || '',
    dept5: def.depts[4] || '',
    dept6: def.depts[5] || '',
    deptLevel: def.deptLevel,
    leaderId: def.leaderId,
    leaderName: def.leaderName,
  };
}

/** 互联网科技 */
const INTERNET = {
  id: 'internet',
  name: '互联网科技',
  description: '扁平化研发组织：技术/产品/市场/运营，强研发导向',
  accent: '#6366f1',
  icon: 'Globe',
  employees: [
    emp('e1', '林涛', 'E001', 'L5', ['技术中心']),
    emp('e2', '陈晨', 'E002', 'L3.2', ['技术中心', '研发部']),
    emp('e3', '王雨', 'E003', 'L2.2', ['技术中心', '研发部', '前端组']),
    emp('e4', '李安', 'E004', 'L2.1', ['技术中心', '研发部', '后端组']),
    emp('e5', '赵敏', 'E005', 'L3.1', ['技术中心', '测试部']),
    emp('e6', '孙杰', 'E006', 'L2.2', ['技术中心', '测试部', '自动化组']),
    emp('e7', '周琪', 'E007', 'L3.2', ['产品部']),
    emp('e8', '吴桐', 'E008', 'L2.1', ['产品部', '设计组']),
    emp('e9', '郑飞', 'E009', 'L3.1', ['市场部']),
    emp('e10', '冯蕾', 'E010', 'L2.2', ['市场部', '增长组']),
  ],
  orgTemplates: [
    org({ depts: ['技术中心'], deptLevel: '1', leaderId: 'E001', leaderName: '林涛' }),
    org({ depts: ['技术中心', '研发部'], deptLevel: '2', leaderId: 'E002', leaderName: '陈晨' }),
    org({ depts: ['技术中心', '测试部'], deptLevel: '2', leaderId: 'E005', leaderName: '赵敏' }),
    org({ depts: ['产品部'], deptLevel: '1', leaderId: 'E007', leaderName: '周琪' }),
    org({ depts: ['市场部'], deptLevel: '1', leaderId: 'E009', leaderName: '郑飞' }),
    org({ depts: ['运营部'], deptLevel: '1' }),
  ],
};

/** 制造业 */
const MANUFACTURING = {
  id: 'manufacturing',
  name: '制造业',
  description: '科层制造组织：生产/质量/供应链/设备，层级偏深',
  accent: '#10b981',
  icon: 'Factory',
  employees: [
    emp('e1', '马建国', 'E001', 'L5', ['制造中心']),
    emp('e2', '钱大力', 'E002', 'L4.1', ['制造中心', '生产部']),
    emp('e3', '孙明', 'E003', 'L3.2', ['制造中心', '生产部', '装配车间']),
    emp('e4', '李荣', 'E004', 'L3.1', ['制造中心', '生产部', '冲压车间']),
    emp('e5', '周正', 'E005', 'L3.2', ['制造中心', '质量部']),
    emp('e6', '吴工', 'E006', 'L2.2', ['制造中心', '质量部', '来料检验']),
    emp('e7', '郑强', 'E007', 'L3.1', ['制造中心', '供应链部']),
    emp('e8', '王仓', 'E008', 'L2.2', ['制造中心', '供应链部', '仓储组']),
    emp('e9', '冯磊', 'E009', 'L3.1', ['制造中心', '设备部']),
  ],
  orgTemplates: [
    org({ depts: ['制造中心'], deptLevel: '1', leaderId: 'E001', leaderName: '马建国' }),
    org({ depts: ['制造中心', '生产部'], deptLevel: '2', leaderId: 'E002', leaderName: '钱大力' }),
    org({ depts: ['制造中心', '质量部'], deptLevel: '2', leaderId: 'E005', leaderName: '周正' }),
    org({ depts: ['制造中心', '供应链部'], deptLevel: '2', leaderId: 'E007', leaderName: '郑强' }),
    org({ depts: ['制造中心', '设备部'], deptLevel: '2', leaderId: 'E009', leaderName: '冯磊' }),
  ],
};

/** 零售连锁 */
const RETAIL = {
  id: 'retail',
  name: '零售连锁',
  description: '门店驱动组织：总部 + 区域 + 门店，直营网络',
  accent: '#f59e0b',
  icon: 'Store',
  employees: [
    emp('e1', '刘总', 'E001', 'L4.2', ['总部']),
    emp('e2', '何静', 'E002', 'L3.2', ['总部', '运营中心']),
    emp('e3', '罗强', 'E003', 'L3.1', ['总部', '商品中心']),
    emp('e4', '高敏', 'E004', 'L2.2', ['总部', '商品中心', '采购组']),
    emp('e5', '陈燕', 'E005', 'L2.2', ['总部', '运营中心', '华东区']),
    emp('e6', '杨帆', 'E006', 'L2.1', ['总部', '运营中心', '华北区']),
    emp('e7', '朱军', 'E007', 'L3.1', ['总部', '电商部']),
    emp('e8', '许婷', 'E008', 'L2.2', ['总部', '运营中心', '华东区', '上海店']),
  ],
  orgTemplates: [
    org({ depts: ['总部'], deptLevel: '1', leaderId: 'E001', leaderName: '刘总' }),
    org({ depts: ['总部', '运营中心'], deptLevel: '2', leaderId: 'E002', leaderName: '何静' }),
    org({ depts: ['总部', '商品中心'], deptLevel: '2', leaderId: 'E003', leaderName: '罗强' }),
    org({ depts: ['总部', '电商部'], deptLevel: '2', leaderId: 'E007', leaderName: '朱军' }),
  ],
};

/** 医院科层 */
const HOSPITAL = {
  id: 'hospital',
  name: '医院科层',
  description: '医疗科层组织：院长/医技/临床/护理，权力链严密',
  accent: '#0ea5e9',
  icon: 'HeartPulse',
  employees: [
    emp('e1', '王院长', 'E001', 'L5', ['医院']),
    emp('e2', '张副院长', 'E002', 'L4.1', ['医院', '临床中心']),
    emp('e3', '李主任', 'E003', 'L3.2', ['医院', '临床中心', '内科']),
    emp('e4', '赵医生', 'E004', 'L2.2', ['医院', '临床中心', '内科', '心内组']),
    emp('e5', '钱医生', 'E005', 'L2.1', ['医院', '临床中心', '外科']),
    emp('e6', '孙护理部', 'E006', 'E4.1', ['医院', '护理部']),
    emp('e7', '周护士长', 'E007', 'E3.1', ['医院', '护理部', '内科病区']),
    emp('e8', '吴技师', 'E008', 'E3.2', ['医院', '医技部']),
    emp('e9', '郑药师', 'E009', 'E3.1', ['医院', '药剂科']),
  ],
  orgTemplates: [
    org({ depts: ['医院'], deptLevel: '1', leaderId: 'E001', leaderName: '王院长' }),
    org({ depts: ['医院', '临床中心'], deptLevel: '2', leaderId: 'E002', leaderName: '张副院长' }),
    org({ depts: ['医院', '临床中心', '内科'], deptLevel: '3', leaderId: 'E003', leaderName: '李主任' }),
    org({ depts: ['医院', '护理部'], deptLevel: '2', leaderId: 'E006', leaderName: '孙护理部' }),
    org({ depts: ['医院', '医技部'], deptLevel: '2', leaderId: 'E008', leaderName: '吴技师' }),
    org({ depts: ['医院', '药剂科'], deptLevel: '2', leaderId: 'E009', leaderName: '郑药师' }),
  ],
};

/** 教育服务 */
const EDUCATION = {
  id: 'education',
  name: '教育服务',
  description: '教育集团组织：教学 / 教务 / 行政 / 校区，事业部分权',
  accent: '#8b5cf6',
  icon: 'GraduationCap',
  employees: [
    emp('e1', '王校长', 'E001', 'L5', ['教育集团']),
    emp('e2', '李教学总监', 'E002', 'L4.1', ['教育集团', '教学中心']),
    emp('e3', '张语文组长', 'E003', 'L3.2', ['教育集团', '教学中心', '语文组']),
    emp('e4', '刘数学组长', 'E004', 'L3.2', ['教育集团', '教学中心', '数学组']),
    emp('e5', '陈教务主任', 'E005', 'L3.1', ['教育集团', '教务部']),
    emp('e6', '赵行政主任', 'E006', 'L3.1', ['教育集团', '行政部']),
    emp('e7', '周校区主任', 'E007', 'L3.2', ['教育集团', '校区']),
    emp('e8', '吴招生专员', 'E008', 'L2.2', ['教育集团', '校区', '招生组']),
  ],
  orgTemplates: [
    org({ depts: ['教育集团'], deptLevel: '1', leaderId: 'E001', leaderName: '王校长' }),
    org({ depts: ['教育集团', '教学中心'], deptLevel: '2', leaderId: 'E002', leaderName: '李教学总监' }),
    org({ depts: ['教育集团', '教务部'], deptLevel: '2', leaderId: 'E005', leaderName: '陈教务主任' }),
    org({ depts: ['教育集团', '行政部'], deptLevel: '2', leaderId: 'E006', leaderName: '赵行政主任' }),
    org({ depts: ['教育集团', '校区'], deptLevel: '2', leaderId: 'E007', leaderName: '周校区主任' }),
  ],
};

/** 全部内置模板（顺序即下拉展示顺序） */
const TEMPLATE_SEEDS: IndustryTemplate[] = [
  INTERNET,
  MANUFACTURING,
  RETAIL,
  HOSPITAL,
  EDUCATION,
];

/** 仅扩充合成演示样本，不用于推断真实组织的负责人、编制或成本。 */
function completeDemoTemplate(source: IndustryTemplate): IndustryTemplate {
  const employees = structuredClone(source.employees);
  const path = (e: Employee | OrgTemplate) => [e.dept1, e.dept2, e.dept3, e.dept4, e.dept5, e.dept6].filter(Boolean) as string[];
  const paths = [...new Map(employees.map((e) => [JSON.stringify(path(e)), path(e)])).values()];
  const leaves = paths.filter((p) => !paths.some((other) => other.length > p.length && p.every((name, i) => name === other[i])));
  for (let i = employees.length; i < 30; i++) {
    const index = String(i + 1).padStart(2, '0');
    employees.push(emp(`demo-${source.id}-${index}`, `演示成员${index}`, `DEMO-${source.id}-${index}`, 'L2.2', leaves[i % leaves.length]));
  }
  const orgTemplates = structuredClone(source.orgTemplates);
  for (const p of paths) {
    if (!orgTemplates.some((o) => JSON.stringify(path(o)) === JSON.stringify(p))) orgTemplates.push(org({ depts: p, deptLevel: String(p.length) }));
  }
  for (const o of orgTemplates) {
    if (o.leaderId || o.leaderName) continue;
    const leader = employees.find((e) => JSON.stringify(path(e)) === JSON.stringify(path(o)));
    if (leader) { o.leaderId = leader.employeeId; o.leaderName = leader.name; }
  }
  return { ...source, description: `${source.description}；合成演示数据，编制与成本不是行业基准`, employees, orgTemplates };
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = TEMPLATE_SEEDS.map(completeDemoTemplate);

/** 载入内置模板，复用 buildDepartmentTree 生成组织树与员工扁平列表。 */
export function loadIndustryTemplate(
  template: IndustryTemplate,
): { departments: Department[]; allEmployeesFlat: Employee[] } {
  const allEmployeesFlat = structuredClone(template.employees);
  const departments = buildDepartmentTree(allEmployeesFlat, template.orgTemplates);
  const configure = (list: Department[]) => {
    for (const d of list) {
      const groups = new Map<string, Employee[]>();
      for (const e of d.employees) {
        const name = e.employeeId === d.leaderId ? '部门负责人' : e.title || '业务专员';
        groups.set(name, [...(groups.get(name) ?? []), e]);
      }
      d.positions = [...groups].map(([name, assigned]): Position => {
        const id = uid('pos');
        const now = new Date().toISOString();
        for (const e of assigned) { e.positionId = id; e.assignmentType = 'primary'; }
        return { id, departmentId: d.id, name, headcount: assigned.length,
          levelBandMin: assigned[0].level, levelBandMax: assigned[0].level,
          status: 'active', createdAt: now, updatedAt: now };
      });
      // 保留空部门作为演示场景，显式给一个空岗与编制，不靠缺失数据制造告警。
      if (d.employees.length === 0 && d.children.length === 0) {
        const now = new Date().toISOString();
        d.positions = [{ id: uid('pos'), departmentId: d.id, name: '待补业务岗', headcount: 1,
          levelBandMin: 'L2.2', levelBandMax: 'L2.2', status: 'active', createdAt: now, updatedAt: now }];
      }
      configure(d.children);
    }
  };
  configure(departments);
  // 把演示组织的结构性推断显式写成示例汇报线，真实导入路径不执行此逻辑。
  for (const manager of deriveManagementLoads(departments).loads) {
    const leader = allEmployeesFlat.find((e) => e.employeeId === manager.key || e.id === manager.key);
    if (!leader) continue;
    for (const e of allEmployeesFlat) if (manager.reports.has(e.employeeId || e.id)) e.reportsToEmployeeId = leader.id;
  }
  return { departments, allEmployeesFlat };
}

/** 按 id 查找模板；未找到返回 null。 */
export function findIndustryTemplate(id: string): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.id === id) ?? null;
}
