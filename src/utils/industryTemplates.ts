import { Employee, Department, OrgTemplate, Position } from '../types';
import { buildDepartmentTree } from './excel';
import { uid } from './project';

/**
 * 内置行业模板（v2.0.3 P1-4）。
 * 预置 5 套、按职能配置人数的合成教学组织，经左侧示例入口载入（互联网/制造/零售/医院/教育）。
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

/** 显式设计的合成组织：各部门人数独立配置；不为跨过诊断门槛统一补人数。
 * 根负责人 + 各职能负责人为正职；首个职能内另有一名有明确下属的专业组长。
 * 未设负责人的业务组用于展示结构推断；推断只在分析时发生，不写回员工资料。
 */
interface DemoDesign {
  id: string; name: string; root: string; teams: string[]; sizes: number[]; accent: string; icon: string;
}
const DESIGNS: DemoDesign[] = [
  { id: 'internet', name: '互联网科技', root: '科技公司', teams: ['研发部', '产品部', '市场部', '运营部'], sizes: [9, 8, 8, 8], accent: '#6366f1', icon: 'Globe' },
  { id: 'manufacturing', name: '制造业', root: '制造中心', teams: ['生产部', '质量部', '供应链部', '设备部', '工艺部', '计划部'], sizes: [8, 9, 8, 8, 9, 8], accent: '#10b981', icon: 'Factory' },
  { id: 'retail', name: '零售连锁', root: '连锁总部', teams: ['华东区', '华北区', '商品中心', '电商部', '运营支持部'], sizes: [9, 8, 8, 9, 8], accent: '#f59e0b', icon: 'Store' },
  { id: 'hospital', name: '医院科层', root: '示例医院', teams: ['内科', '外科', '护理部', '医技部', '药剂科', '行政部'], sizes: [9, 9, 8, 8, 8, 8], accent: '#0ea5e9', icon: 'HeartPulse' },
  { id: 'education', name: '教育服务', root: '教育集团', teams: ['教学中心', '教务部', '行政部', '东校区', '西校区'], sizes: [8, 8, 8, 9, 9], accent: '#8b5cf6', icon: 'GraduationCap' },
];

function createDemo(design: DemoDesign): IndustryTemplate {
  let sequence = 0;
  const person = (name: string, level: string, depts: string[]) => {
    const number = String(++sequence).padStart(3, '0');
    return emp(`demo-${design.id}-${number}`, name, `DEMO-${design.id}-${number}`, level, depts);
  };
  const chief = person('示例总负责人', 'L5', [design.root]);
  const employees = [chief, ...['人力', '财务', '法务', '行政', '数据', '内控'].map((role) => person(`示例${role}专员`, 'L2.2', [design.root]))];
  const orgTemplates = [org({ depts: [design.root], deptLevel: '1', leaderId: chief.employeeId, leaderName: chief.name })];
  design.teams.forEach((team, index) => {
    const path = [design.root, team];
    const owner = person(`示例${team}负责人`, 'L4.1', path);
    employees.push(owner);
    orgTemplates.push(org({ depts: path, deptLevel: '2', leaderId: owner.employeeId, leaderName: owner.name }));
    // 业务组没有行政负责人，其成员默认向最近的职能负责人汇报。
    const group = [...path, `${team}业务组`];
    orgTemplates.push(org({ depts: group, deptLevel: '3' }));
    let teamLead: Employee | undefined;
    for (let i = 1; i < design.sizes[index]; i++) {
      const member = person(`示例${team}成员${i}`, 'L2.2', group);
      if (index === 0 && i === 1) { teamLead = member; member.title = '专业组长'; }
      // 仅这三条关系是示例设计的显式事实；它们不来自结构推断。
      if (teamLead && i >= 2 && i <= 4) member.reportsToEmployeeId = teamLead.employeeId;
      employees.push(member);
    }
  });
  return { ...design, description: '合成教学组织：默认基准下整体健康，含 1 个待招岗；正职负责人和专业带人者分别展示，未设负责人的业务组保留推断边界。人数、编制和成本均非行业基准。', employees, orgTemplates };
}

/** 全部内置模板（顺序即下拉展示顺序）。 */
export const INDUSTRY_TEMPLATES: IndustryTemplate[] = DESIGNS.map(createDemo);

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
  // 一个明确标注的待招岗位：保持整体健康，同时演示局部缺口，不制造负责人。
  const firstTeam = departments[0]?.children[0];
  if (firstTeam) {
    const now = new Date().toISOString();
    firstTeam.positions!.push({ id: uid('pos'), departmentId: firstTeam.id, name: '示例待招专员', headcount: 1,
      levelBandMin: 'L2.2', levelBandMax: 'L2.2', status: 'active', createdAt: now, updatedAt: now });
  }
  return { departments, allEmployeesFlat };
}

/** 按 id 查找模板；未找到返回 null。 */
export function findIndustryTemplate(id: string): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.id === id) ?? null;
}
