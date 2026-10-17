import { Employee, Department, OrgTemplate, Position, Successor } from '../types';
import { buildDepartmentTree } from './excel';
import { uid } from './project';

/**
 * 内置行业模板（v2.0.3 P1-4；v2.5.1 重建）。
 * 五套合成教学组织，按真实行业形态搭建（制造：工厂→车间→产线；零售：大区→片区→门店；
 * 医院：临床系统→科室→病区；互联网：扁平知识型团队；教育：集团→校区→年级组）。
 * 每套各埋 1–2 个行业典型问题（写在 description 里），其余指标按默认基准健康，
 * 用于演示红/黄灯是如何把问题找出来的。人数、编制与成本均为合成数据，不是行业基准。
 *
 * 数据全部是显式事实：汇报关系（reportsToEmployeeId）、岗位序列、继任人与空缺岗位都写在模板里，
 * 载入时只建树、套岗、挂继任，不做任何结构推断写回。
 */

export interface TemplatePlan {
  /** 工号 → 岗位序列（与岗位与编制页的序列选项一致） */
  families: Record<string, string>;
  /** 正职负责人工号 → 其岗位的继任人（工号 + 准备度） */
  successors: Record<string, Successor[]>;
  /** 负责人空缺的关键岗位（部门路径 + 岗位名 + 职级），不配继任人即为单点风险 */
  vacancies: { path: string[]; title: string; level: string }[];
}

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
  plan: TemplatePlan;
}

/* ———————————————— 声明式组织描述 ———————————————— */

interface PersonSpec { role: string; level: string; family: string; key?: string; reportsTo?: string; count?: number }
interface UnitSpec {
  name: string;
  owner?: PersonSpec;
  /** 负责人空缺：岗位在编但无在任者（关键岗位，默认不配继任人） */
  vacant?: { role: string; level: string };
  /** 本部门负责人不配继任人（用于演示单点风险） */
  noSuccessor?: boolean;
  members?: PersonSpec[];
  children?: UnitSpec[];
}

const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split('');
const GIVEN = '伟 芳 娜 敏 静 丽 强 磊 军 洋 勇 艳 杰 娟 涛 明 超 霞 平 刚 婷 宇 浩 凯 鹏 欣 悦 晨 琳 博 帆 健 华 亮 斌 颖 倩 雪 梅 辉 慧 佳 阳 峰 蕾 晶 琪 瑶 楠 昊 然 鑫 睿 彤 航 旭 哲 怡 璐 萍'.split(' ');
const GIVEN2 = ['', '思', '子', '嘉', '文', '宏', '雅', '志', '晓', '俊', '家', '一'];

/** 确定性中文姓名：姓与名按不同步长交错取值，同一模板内去重（重名会触发“重名无法匹配”）。 */
function makeNamer(offset: number): () => string {
  const used = new Set<string>();
  let i = offset;
  return () => {
    for (;;) {
      i++;
      const surname = SURNAMES[(i * 17) % SURNAMES.length];
      const given = GIVEN[(i * 7 + Math.floor(i / GIVEN.length)) % GIVEN.length];
      const middle = GIVEN2[(i * 5 + Math.floor(i / 97)) % GIVEN2.length];
      const name = `${surname}${middle}${given}`;
      if (!used.has(name)) { used.add(name); return name; }
    }
  };
}

function buildTemplate(meta: Omit<IndustryTemplate, 'employees' | 'orgTemplates' | 'plan'>, prefix: string, root: UnitSpec): IndustryTemplate {
  const employees: Employee[] = [];
  const orgTemplates: OrgTemplate[] = [];
  const plan: TemplatePlan = { families: {}, successors: {}, vacancies: [] };
  const keyToNumber = new Map<string, string>();
  const pendingReports: { employee: Employee; key: string }[] = [];
  let seq = 0;
  // 姓名序号错开起点，避免五个模板首位负责人同姓同名
  const nextName = makeNamer(prefix.charCodeAt(0) * 7);

  const person = (spec: PersonSpec, path: string[]): Employee => {
    seq++;
    const employeeId = `${prefix}${String(seq).padStart(4, '0')}`;
    const e: Employee = {
      id: `tpl-${prefix}-${seq}`, employeeId, name: nextName(), level: spec.level, title: spec.role,
      dept1: path[0] || '', dept2: path[1] || '', dept3: path[2] || '', dept4: path[3] || '', dept5: path[4] || '', dept6: path[5] || '',
    };
    plan.families[employeeId] = spec.family;
    if (spec.key) keyToNumber.set(spec.key, employeeId);
    employees.push(e);
    return e;
  };

  const walk = (unit: UnitSpec, parentPath: string[], parentOwner: string | undefined) => {
    const path = [...parentPath, unit.name];
    const owner = unit.owner ? person(unit.owner, path) : undefined;
    orgTemplates.push({
      dept1: path[0] || '', dept2: path[1] || '', dept3: path[2] || '', dept4: path[3] || '', dept5: path[4] || '', dept6: path[5] || '',
      deptLevel: String(path.length), leaderId: owner?.employeeId, leaderName: owner?.name,
    });
    if (owner) {
      if (unit.owner!.reportsTo) pendingReports.push({ employee: owner, key: unit.owner!.reportsTo });
      else if (parentOwner) owner.reportsToEmployeeId = parentOwner;
    }
    if (unit.vacant) plan.vacancies.push({ path, title: unit.vacant.role, level: unit.vacant.level });
    const boss = owner?.employeeId ?? parentOwner;
    const members: Employee[] = [];
    for (const spec of unit.members ?? []) {
      for (let i = 0; i < (spec.count ?? 1); i++) {
        const m = person({ ...spec, key: spec.count && spec.count > 1 ? undefined : spec.key }, path);
        if (spec.reportsTo) pendingReports.push({ employee: m, key: spec.reportsTo });
        else if (boss) m.reportsToEmployeeId = boss;
        members.push(m);
      }
    }
    const childOwners = (unit.children ?? []).map((child) => walk(child, path, boss)).filter((e): e is Employee => !!e);
    // 继任：模板里显式写明的“近期可接”人选——本部门职级最高的副手/骨干，没有成员时取下级负责人。
    if (owner && !unit.noSuccessor) {
      const rank = (e: Employee) => Number(e.level.replace(/^[A-Z]+/, '')) || 0;
      const pool = [...members, ...childOwners].filter((e) => e !== owner).sort((a, b) => rank(b) - rank(a));
      if (pool[0]) plan.successors[owner.employeeId] = [{ employeeId: pool[0].employeeId, readiness: 'ready_1_2y' }];
    }
    return owner;
  };
  walk(root, [], undefined);
  for (const { employee, key } of pendingReports) {
    const target = keyToNumber.get(key);
    if (!target) throw new Error(`模板 ${meta.id}：汇报对象 ${key} 不存在`);
    employee.reportsToEmployeeId = target;
  }
  return { ...meta, employees, orgTemplates, plan };
}

const LEAD = '管理';
const line = (name: string, workers: number): UnitSpec => ({
  name, owner: { role: '线长', level: 'L2.1', family: LEAD }, members: [{ role: '操作工', level: 'L1.1', family: '生产', count: workers }],
});
const store = (name: string): UnitSpec => ({
  name, owner: { role: '店长', level: 'L2.2', family: LEAD }, members: [{ role: '店员', level: 'L1.1', family: '门店', count: 10 }],
});
const ward = (name: string, nurses: number): UnitSpec => ({
  name, owner: { role: '护士长', level: 'L2.2', family: LEAD }, members: [{ role: '护士', level: 'L1.2', family: '护理', count: nurses }],
});

/* 制造：工厂 → 车间 → 产线（→ 工段），操作型幅度 15–25；问题：总装车间多出“副主任 + 工段长”两层，形成一条 6 层的孤立深链。 */
const MANUFACTURING = buildTemplate({
  id: 'manufacturing', name: '制造业', accent: '#10b981', icon: 'Factory',
  description: '汽车零部件工厂：工厂→车间→产线，线长直管 15–20 名操作工。预置问题：总装车间在主任与线长之间多出「副主任＋工段长」两层，三线操作工到总经理隔 6 位管理者（孤立深链，汇报链判关注；副主任、工段长各只带 1 人）。其余指标按默认基准健康。合成数据，非行业基准。',
}, 'M', {
  name: '华东汽配制造公司', owner: { role: '总经理', level: 'L5', family: LEAD },
  members: [{ role: '总经理助理', level: 'L2.2', family: '职能' }],
  children: [
    { name: '生产部', owner: { role: '厂长', level: 'L4.2', family: LEAD },
      members: [{ role: '生产计划员', level: 'L2.1', family: '运营', count: 3 }, { role: '安全工程师', level: 'L2.1', family: '技术', count: 2 }],
      children: [
        { name: '冲压车间', owner: { role: '车间主任', level: 'L3.2', family: LEAD },
          members: [{ role: '工艺员', level: 'L2.1', family: '技术' }, { role: '统计员', level: 'L1.2', family: '职能' }],
          children: [line('冲压一线', 16), line('冲压二线', 15), line('冲压三线', 18)] },
        { name: '焊装车间', owner: { role: '车间主任', level: 'L3.2', family: LEAD },
          members: [{ role: '工艺员', level: 'L2.1', family: '技术' }, { role: '统计员', level: 'L1.2', family: '职能' }],
          children: [line('焊装一线', 17), line('焊装二线', 20), line('焊装三线', 15)] },
        { name: '总装车间', owner: { role: '车间主任', level: 'L3.2', family: LEAD },
          members: [{ role: '车间副主任', level: 'L3.1', family: LEAD, key: 'zz-deputy' }, { role: '工艺员', level: 'L2.1', family: '技术' }, { role: '统计员', level: 'L1.2', family: '职能' }],
          children: [line('总装一线', 18), line('总装二线', 16),
            { name: '总装三工段', owner: { role: '工段长', level: 'L2.2', family: LEAD, reportsTo: 'zz-deputy' }, children: [line('总装三线', 10)] }] },
      ] },
    { name: '质量部', owner: { role: '质量部长', level: 'L4.1', family: LEAD },
      members: [{ role: '质量工程师', level: 'L2.2', family: '技术', count: 6 }, { role: '质检组长', level: 'L2.1', family: LEAD, key: 'qc-lead' },
        { role: '质检员', level: 'L1.1', family: '生产', count: 14, reportsTo: 'qc-lead' }] },
    { name: '供应链部', owner: { role: '供应链部长', level: 'L4.1', family: LEAD },
      members: [{ role: '采购专员', level: 'L2.1', family: '运营', count: 4 }, { role: '物料计划员', level: 'L2.1', family: '运营', count: 2 },
        { role: '仓储主管', level: 'L2.1', family: LEAD, key: 'wh-lead' }, { role: '仓管员', level: 'L1.1', family: '仓储', count: 15, reportsTo: 'wh-lead' }] },
    { name: '设备部', owner: { role: '设备部长', level: 'L4.1', family: LEAD }, members: [{ role: '设备工程师', level: 'L2.2', family: '技术', count: 7 }] },
    { name: '人力行政部', owner: { role: '人力行政部长', level: 'L4.1', family: LEAD },
      members: [{ role: '人力专员', level: 'L2.1', family: '职能', count: 4 }, { role: '行政专员', level: 'L1.2', family: '职能', count: 3 }] },
  ],
});

/* 零售：总部 → 大区 → 片区 → 门店；问题：华东一片区经理直管 16 家门店店长（知识型上限 15）。 */
const RETAIL = buildTemplate({
  id: 'retail', name: '零售连锁', accent: '#f59e0b', icon: 'Store',
  description: '社区超市连锁：总部→大区→片区→门店，店长直管 10 名店员。预置问题：华东一片区经理一人直管 16 家门店店长，超过默认上限（单点幅度过宽，管理幅度判关注），其余片区 5 家店。其余指标按默认基准健康。合成数据，非行业基准。',
}, 'R', {
  name: '惠邻连锁总部', owner: { role: '总裁', level: 'L5', family: LEAD },
  members: [{ role: '总裁助理', level: 'L2.2', family: '职能' }],
  children: [
    { name: '华东大区', owner: { role: '大区总监', level: 'L4.2', family: LEAD },
      members: [{ role: '营运督导', level: 'L2.2', family: '运营', count: 2 }, { role: '大区人事专员', level: 'L2.1', family: '职能' }],
      children: [
        { name: '华东一片区', owner: { role: '片区经理', level: 'L3.2', family: LEAD },
          children: ['徐汇', '静安', '长宁', '普陀', '虹口', '杨浦', '闵行', '宝山', '嘉定', '松江', '青浦', '奉贤', '金山', '崇明', '浦东', '黄浦'].map((n) => store(`上海${n}店`)) },
        { name: '华东二片区', owner: { role: '片区经理', level: 'L3.2', family: LEAD },
          children: ['西湖', '拱墅', '上城', '滨江', '萧山'].map((n) => store(`杭州${n}店`)) },
      ] },
    { name: '华北大区', owner: { role: '大区总监', level: 'L4.2', family: LEAD },
      members: [{ role: '营运督导', level: 'L2.2', family: '运营', count: 3 }, { role: '大区人事专员', level: 'L2.1', family: '职能' }],
      children: [{ name: '华北一片区', owner: { role: '片区经理', level: 'L3.2', family: LEAD },
        children: ['朝阳', '海淀', '丰台', '东城', '西城'].map((n) => store(`北京${n}店`)) }] },
    { name: '商品中心', owner: { role: '商品总监', level: 'L4.1', family: LEAD }, members: [{ role: '采购经理', level: 'L2.2', family: '运营', count: 6 }] },
    { name: '营运支持部', owner: { role: '营运支持总监', level: 'L4.1', family: LEAD }, members: [{ role: '营运专员', level: 'L2.1', family: '运营', count: 7 }] },
    { name: '人力财务部', owner: { role: '人力财务总监', level: 'L4.1', family: LEAD }, members: [{ role: '人力财务专员', level: 'L2.1', family: '职能', count: 8 }] },
  ],
});

/* 医院：医院 → 临床医学部 → 科室 → 病区；问题：外科一名主任医师（E4.1）向职级更低的科主任（L3.2）汇报。 */
const HOSPITAL = buildTemplate({
  id: 'hospital', name: '医院科层', accent: '#0ea5e9', icon: 'HeartPulse',
  description: '二级综合医院：医院→临床医学部→科室→病区，护士长直管 13–15 名护士。预置问题：外科一名主任医师（E4.1）向职级更低的科主任（L3.2）汇报，形成职级倒挂（职级倒挂判预警）。其余指标按默认基准健康。合成数据，非行业基准。',
}, 'H', {
  name: '示例第二人民医院', owner: { role: '院长', level: 'L5', family: LEAD },
  members: [{ role: '院办主任', level: 'L3.1', family: '职能' }],
  children: [
    { name: '临床医学部', owner: { role: '业务副院长', level: 'L4.2', family: LEAD },
      members: [{ role: '医务科专员', level: 'L2.2', family: '职能', count: 3 }],
      children: [
        { name: '内科', owner: { role: '内科主任', level: 'L4.1', family: LEAD },
          members: [{ role: '副主任医师', level: 'E3.2', family: '医疗', count: 2 }, { role: '主治医师', level: 'E3.1', family: '医疗', count: 4 }],
          children: [ward('心内科病区', 14), ward('消化内科病区', 13)] },
        { name: '外科', owner: { role: '外科主任', level: 'L3.2', family: LEAD },
          members: [{ role: '主任医师', level: 'E4.1', family: '医疗' }, { role: '主治医师', level: 'E3.1', family: '医疗', count: 6 }],
          children: [ward('普外科病区', 14), ward('骨科病区', 15)] },
      ] },
    { name: '医技部', owner: { role: '医技部主任', level: 'L4.1', family: LEAD },
      members: [{ role: '检验技师', level: 'L2.2', family: '医疗', count: 5 }, { role: '影像技师', level: 'L2.2', family: '医疗', count: 4 }] },
    { name: '护理部', owner: { role: '护理部主任', level: 'L4.1', family: LEAD }, members: [{ role: '护理督导', level: 'L2.2', family: '职能', count: 5 }] },
    { name: '行政后勤部', owner: { role: '行政后勤主任', level: 'L4.1', family: LEAD }, members: [{ role: '行政后勤专员', level: 'L2.1', family: '职能', count: 8 }] },
  ],
});

/* 互联网：扁平知识型团队；问题：研发中心在 VP 与工程师之间加了一层只带 2 人的组长。 */
const INTERNET = buildTemplate({
  id: 'internet', name: '互联网科技', accent: '#6366f1', icon: 'Globe',
  description: 'SaaS 公司：扁平的知识型团队，各部门负责人直管 8–10 人。预置问题：研发中心在技术 VP 与工程师之间多设了 8 个只带 2 人的组长，管理层过窄——知识型管理幅度中位数偏低（关注），并连带抬高管理者比（关注）。其余指标按默认基准健康。合成数据，非行业基准。',
}, 'I', {
  name: '云栖科技', owner: { role: 'CEO', level: 'L5', family: LEAD },
  members: [{ role: '战略分析师', level: 'L3.1', family: '战略' }],
  children: [
    { name: '研发中心', owner: { role: '技术VP', level: 'L4.2', family: LEAD },
      members: [{ role: '架构师', level: 'E3.2', family: '技术', count: 2 },
        ...Array.from({ length: 8 }, (_, i): PersonSpec => ({ role: '研发组长', level: 'L3.1', family: LEAD, key: `dev-lead-${i}` })),
        ...Array.from({ length: 8 }, (_, i): PersonSpec => ({ role: '软件工程师', level: 'L2.1', family: '技术', count: 2, reportsTo: `dev-lead-${i}` }))] },
    { name: '产品部', owner: { role: '产品总监', level: 'L4.1', family: LEAD }, members: [{ role: '产品经理', level: 'L2.2', family: '产品', count: 10 }] },
    { name: '设计部', owner: { role: '设计总监', level: 'L4.1', family: LEAD }, members: [{ role: '设计师', level: 'L2.1', family: '设计', count: 9 }] },
    { name: '运营部', owner: { role: '运营总监', level: 'L4.1', family: LEAD }, members: [{ role: '运营专员', level: 'L2.1', family: '运营', count: 10 }] },
    { name: '市场部', owner: { role: '市场总监', level: 'L4.1', family: LEAD }, members: [{ role: '市场专员', level: 'L2.1', family: '市场', count: 10 }] },
    { name: '职能部', owner: { role: '职能总监', level: 'L4.1', family: LEAD }, members: [{ role: '人力财务专员', level: 'L2.1', family: '职能', count: 9 }] },
  ],
});

/* 教育：集团 → 校区 → 年级组；问题：东校区校长空缺且无继任人，年级组长临时直接向总校长汇报。 */
const EDUCATION = buildTemplate({
  id: 'education', name: '教育服务', accent: '#8b5cf6', icon: 'GraduationCap',
  description: 'K12 教育集团：集团→校区，年级组长带 8 名教师。预置问题：东校区校长岗位空缺且没有任何继任人，4 位年级组长临时直接向总校长汇报（关键岗位空缺单点风险，继任覆盖判关注）。其余指标按默认基准健康。合成数据，非行业基准。',
}, 'E', {
  name: '明德教育集团', owner: { role: '总校长', level: 'L5', family: LEAD, key: 'edu-head' },
  members: [{ role: '集团办公室主任', level: 'L2.2', family: '职能' }],
  children: [
    { name: '东校区', vacant: { role: '校区校长', level: 'L4.1' },
      members: [
        ...Array.from({ length: 4 }, (_, i): PersonSpec => ({ role: '年级组长', level: 'L3.1', family: LEAD, key: `east-${i}`, reportsTo: 'edu-head' })),
        ...Array.from({ length: 4 }, (_, i): PersonSpec => ({ role: '教师', level: 'L2.1', family: '教学', count: 8, reportsTo: `east-${i}` }))] },
    { name: '西校区', owner: { role: '校区校长', level: 'L4.1', family: LEAD },
      members: [{ role: '校区教务干事', level: 'L2.1', family: '职能', count: 2 },
        ...Array.from({ length: 4 }, (_, i): PersonSpec => ({ role: '年级组长', level: 'L3.1', family: LEAD, key: `west-${i}` })),
        ...Array.from({ length: 4 }, (_, i): PersonSpec => ({ role: '教师', level: 'L2.1', family: '教学', count: 8, reportsTo: `west-${i}` }))] },
    { name: '南校区', owner: { role: '校区校长', level: 'L4.1', family: LEAD },
      members: [{ role: '校区教务干事', level: 'L2.1', family: '职能', count: 2 },
        ...Array.from({ length: 3 }, (_, i): PersonSpec => ({ role: '年级组长', level: 'L3.1', family: LEAD, key: `south-${i}` })),
        ...Array.from({ length: 3 }, (_, i): PersonSpec => ({ role: '教师', level: 'L2.1', family: '教学', count: 8, reportsTo: `south-${i}` }))] },
    { name: '教务中心', owner: { role: '教务主任', level: 'L4.1', family: LEAD }, members: [{ role: '教务专员', level: 'L2.1', family: '职能', count: 7 }] },
    { name: '人力财务部', owner: { role: '人力财务主任', level: 'L4.1', family: LEAD }, members: [{ role: '人力财务专员', level: 'L2.1', family: '职能', count: 8 }] },
  ],
});

/** 全部内置模板（顺序即下拉展示顺序）。 */
export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [INTERNET, MANUFACTURING, RETAIL, HOSPITAL, EDUCATION];

/** 载入内置模板：复用 buildDepartmentTree 建树，再按模板显式数据套岗、挂继任、标空缺。 */
export function loadIndustryTemplate(
  template: IndustryTemplate,
): { departments: Department[]; allEmployeesFlat: Employee[] } {
  const allEmployeesFlat = structuredClone(template.employees);
  const departments = buildDepartmentTree(allEmployeesFlat, template.orgTemplates);
  const now = new Date().toISOString();
  const vacancyByPath = new Map(template.plan.vacancies.map((v) => [v.path.join('/'), v]));
  const configure = (list: Department[], parentPath: string[]) => {
    for (const d of list) {
      const path = [...parentPath, d.name];
      const groups = new Map<string, Employee[]>();
      for (const e of d.employees) {
        const family = template.plan.families[e.employeeId] ?? '';
        const key = `${e.title ?? ''}|${family}|${e.level}|${e.employeeId === d.leaderId ? 'owner' : ''}`;
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
      d.positions = [...groups].map(([key, assigned]): Position => {
        const [name, family] = key.split('|');
        const id = uid('pos');
        for (const e of assigned) { e.positionId = id; e.assignmentType = 'primary'; }
        const owner = assigned.find((e) => e.employeeId === d.leaderId);
        const successors = owner ? template.plan.successors[owner.employeeId] : undefined;
        return { id, departmentId: d.id, name, headcount: assigned.length, jobFamily: family || undefined,
          levelBandMin: assigned[0].level, levelBandMax: assigned[0].level, status: 'active', createdAt: now, updatedAt: now,
          ...(successors ? { successors: structuredClone(successors) } : {}) };
      });
      const vacancy = vacancyByPath.get(path.join('/'));
      if (vacancy) {
        d.leaderType = 'vacant';
        d.positions.unshift({ id: uid('pos'), departmentId: d.id, name: vacancy.title, headcount: 1, jobFamily: LEAD,
          levelBandMin: vacancy.level, levelBandMax: vacancy.level, status: 'active', isCritical: true, successors: [], createdAt: now, updatedAt: now });
      }
      configure(d.children, path);
    }
  };
  configure(departments, []);
  return { departments, allEmployeesFlat };
}

/** 按 id 查找模板；未找到返回 null。 */
export function findIndustryTemplate(id: string): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.id === id) ?? null;
}
