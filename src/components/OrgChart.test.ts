import { describe, it, expect } from 'vitest';
import { calculateTreeLayout, countLeaves, estimateCardHeight, CARD_WIDTH as REAL_CARD_WIDTH } from './OrgChart';
import { buildDepartmentTree } from '../utils/excel';
import type { Department, Employee } from '../types';

function treeOf(): Department[] {
  const E: Employee[] = [
    { id: '1', name: '张三', employeeId: 'E001', level: 'L1.1', dept1: '技术部', dept2: '研发组', dept3: '后端' },
    { id: '2', name: '李四', employeeId: 'E002', level: 'L2.1', dept1: '技术部', dept2: '研发组', dept3: '后端' },
    { id: '3', name: '王五', employeeId: 'E003', level: 'L3.1', dept1: '技术部', dept2: '研发组', dept3: '前端' },
    { id: '4', name: '赵六', employeeId: 'E004', level: 'L1.2', dept1: '技术部', dept2: '测试组', dept3: '功能测试' },
    { id: '5', name: '钱七', employeeId: 'E005', level: 'L2.2', dept1: '技术部', dept2: '测试组', dept3: '自动化测试' },
    { id: '6', name: '孙八', employeeId: 'E006', level: 'L3.2', dept1: '技术部', dept2: '运维组', dept3: '运维' },
    { id: '7', name: '周九', employeeId: 'E007', level: 'E3.1', dept1: '销售部', dept2: '华东区' },
    { id: '8', name: '吴十', employeeId: 'E008', level: 'E3.2', dept1: '销售部', dept2: '华北区' },
    { id: '9', name: '郑十一', employeeId: 'E009', level: 'L4.1', dept1: '销售部', dept2: '华南区' },
    { id: '10', name: '陈十二', employeeId: 'E010', level: 'L5', dept1: '人力资源部', dept2: '招聘组' },
  ];
  return buildDepartmentTree(E, []);
}

// 卡宽必须与实现共用同一个常量：写死数值会在改宽度时让断言全部静默失真（v2.3.2：220 → 320）
const CARD_WIDTH = REAL_CARD_WIDTH;

function walk(nodes: ReturnType<typeof calculateTreeLayout>, cb: (n: ReturnType<typeof calculateTreeLayout>[number]) => void) {
  for (const n of nodes) { cb(n); walk(n.children, cb); }
}

/** 父卡片中心（其子树带中点） */
function parentCenter(n: ReturnType<typeof calculateTreeLayout>[number]): number {
  return n.x + CARD_WIDTH / 2;
}

describe('calculateTreeLayout（方案A 绝对定位布局）', () => {
  it('坐标合理：不爆炸（回归 v2.0.3 宽度算法 bug）', () => {
    const nodes = calculateTreeLayout(treeOf(), 0, 0, 100);
    let maxRight = 0;
    walk(nodes, (n) => { maxRight = Math.max(maxRight, n.x + n.width); });
    expect(maxRight).toBeGreaterThan(0);
    expect(maxRight).toBeLessThan(5000);
  });

  it('根部门 y=0，子部门 y=父卡估算高度+40（层级步进按卡高动态计算，v2.0.10）', () => {
    const nodes = calculateTreeLayout(treeOf(), 0, 0, 100);
    for (const n of nodes) {
      expect(n.y).toBe(0);
      for (const c of n.children) {
        expect(c.y).toBe(estimateCardHeight(n.department) + 40);
      }
    }
  });

  it('上级卡高增长 → 子部门整体下移且不被遮挡（回归 v2.0.9 遮挡 bug；v2.0.11 收起/展开两态）', () => {
    // 上级部门直挂 6 名员工
    const emps: Employee[] = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      name: `员工${i}`,
      employeeId: `E${i}`,
      level: 'L1.1',
    }));
    const child: Department = {
      id: 'child',
      name: '子部门',
      level: 2,
      parentId: 'parent',
      children: [],
      employees: [],
      expanded: true,
      headcount: undefined,
    };
    const parent: Department = {
      id: 'parent',
      name: '上级部门',
      level: 1,
      children: [child],
      employees: emps,
      expanded: true,
      headcount: undefined,
    };

    // 空岗位区不渲染，收起态应保持紧凑，不能留下已删除控件的高度。
    const collapsedH = estimateCardHeight(parent, false);
    const nodesCollapsed = calculateTreeLayout([parent], 0, 0, 100, new Set());
    const pCollapsed = nodesCollapsed[0];
    expect(pCollapsed.children[0].y).toBe(pCollapsed.y + collapsedH + 40);
    expect(collapsedH).toBeGreaterThan(150);
    expect(collapsedH).toBeLessThan(180);

    // 展开态：全部成员平铺（无滚动上限），卡高随成员+岗位区增长（正是旧版漏掉的“高卡”情形）
    const expandedH = estimateCardHeight(parent, true);
    const nodesExpanded = calculateTreeLayout([parent], 0, 0, 100, new Set(['parent']));
    const pExpanded = nodesExpanded[0];
    expect(expandedH).toBeGreaterThan(collapsedH); // 展开 ≥ 收起
    expect(pExpanded.children[0].y).toBe(pExpanded.y + expandedH + 40); // 子卡顶 = 父卡底（估算）+ 40 间距
    expect(pExpanded.children[0].y).toBeGreaterThan(pExpanded.y + expandedH - 1); // 不重叠
  });

  it('成员列表展开/收起 → 子部门位置随卡高变化（v2.0.11）', () => {
    const emps: Employee[] = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`, name: `员工${i}`, employeeId: `E${i}`, level: 'L1.1',
    }));
    const child: Department = {
      id: 'c', name: '子', level: 2, parentId: 'p', children: [], employees: [], expanded: true,
    };
    const parent: Department = {
      id: 'p', name: '父', level: 1, children: [child], employees: emps, expanded: true,
    };
    const collapsedY = calculateTreeLayout([parent], 0, 0, 100, new Set())[0].children[0].y;
    const expandedY = calculateTreeLayout([parent], 0, 0, 100, new Set(['p']))[0].children[0].y;
    expect(expandedY).toBeGreaterThan(collapsedY); // 展开时子部门下移
    expect(expandedY - collapsedY).toBe(5 * 46 + 4 * 4 - 28); // 差值 = 全行数高 − 收起单行高
  });

  it('空部门（0 成员）子部门间距 = 估算高度 + 40（最小卡高不挤压子卡）', () => {
    const child: Department = {
      id: 'child2', name: '子', level: 2, parentId: 'p2', children: [], employees: [], expanded: true,
    };
    const parent: Department = {
      id: 'p2', name: '父', level: 1, children: [child], employees: [], expanded: true,
    };
    const nodes = calculateTreeLayout([parent], 0, 0, 100);
    expect(nodes[0].children[0].y).toBe(estimateCardHeight(parent) + 40);
  });

  it('叶子数正确（countLeaves），折叠子部门计为 1', () => {
    const tree = treeOf();
    const tech = tree.find((r) => r.name === '技术部')!;
    expect(countLeaves(tech)).toBe(5);
    const leaf = tech.children[0].children[0]; // 功能测试
    expect(countLeaves(leaf)).toBe(1);
  });

  it('多个根部门水平排列且**带宽**互不重叠（v2.3.1 T-02：旧断言只验 x 递增）', () => {
    const nodes = calculateTreeLayout(treeOf(), 0, 0, 100);
    expect(nodes.length).toBeGreaterThan(1);
    // 带宽左/右缘（band = 子树占用宽度；卡片居中于带内）
    const bandLeft = (n: (typeof nodes)[number]) => n.x + CARD_WIDTH / 2 - n.width / 2;
    const bandRight = (n: (typeof nodes)[number]) => n.x + CARD_WIDTH / 2 + n.width / 2;
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].x).toBeGreaterThan(nodes[i - 1].x);
      // 真正的「不重叠」：后一个根部门的带宽左缘不得早于前一个的右缘
      expect(bandLeft(nodes[i])).toBeGreaterThanOrEqual(bandRight(nodes[i - 1]));
    }
  });

  /**
   * v2.3.1（T-02）：原用例是**代数恒真**的 —— pc 与 blockCenter 都由同一个 n.x/n.width 推出，
   * 任何输入都相等（已验证：把根节点整体偏移 37px 该用例仍通过，仅根节点 x+37 也通过）。
   * 现在改为三条**有判别力**的独立断言：
   * 1) 绝对锚点：带宽左缘必须落在调用方给定的 parentX 上；
   * 2) 子部门真实span 必须与父部门声明的带宽一致（用子节点坐标反推，不复用 n.width）；
   * 3) 父卡中心必须等于子部门真实 span 的中点。
   */
  it('父卡片水平居中于其子部门块中点（用子节点坐标独立校验，非恒等式）', () => {
    const START_X = 400;
    const nodes = calculateTreeLayout(treeOf(), START_X, 0, 100);
    const bandLeft = (n: ReturnType<typeof calculateTreeLayout>[number]) => n.x + CARD_WIDTH / 2 - n.width / 2;
    const bandRight = (n: ReturnType<typeof calculateTreeLayout>[number]) => n.x + CARD_WIDTH / 2 + n.width / 2;

    // 1) 绝对锚点：根部门的带宽左缘 = 调用方给定坐标
    expect(Math.abs(bandLeft(nodes[0]) - START_X)).toBeLessThan(1);

    const check = (list: ReturnType<typeof calculateTreeLayout>) => {
      for (const n of list) {
        if (n.children.length > 0) {
          const first = n.children[0];
          const last = n.children[n.children.length - 1];
          // 2) 子部门整体占用的 span 与父部门声明的带宽一致
          expect(Math.abs(bandLeft(first) - bandLeft(n))).toBeLessThan(1);
          expect(Math.abs(bandRight(last) - bandRight(n))).toBeLessThan(1);
          // 3) 父卡中心 = 子部门真实 span 的中点（独立于父节点的 width 字段）
          const childrenMid = (bandLeft(first) + bandRight(last)) / 2;
          expect(Math.abs(parentCenter(n) - childrenMid)).toBeLessThan(1);
        }
        check(n.children);
      }
    };
    check(nodes);
  });

  it('子部门块恰好填满父的子树带宽，且兄弟间水平间距一致', () => {
    const nodes = calculateTreeLayout(treeOf(), 0, 0, 100);
    const check = (list: ReturnType<typeof calculateTreeLayout>) => {
      for (const n of list) {
        if (n.children.length > 0) {
          // 父的子树带左缘
          const bandLeft = n.x + CARD_WIDTH / 2 - n.width / 2;
          // 子部门块：首个子的带左缘 到 末个子的带右缘
          const firstLeft = n.children[0].x + CARD_WIDTH / 2 - n.children[0].width / 2;
          const lastRight = n.children[n.children.length - 1].x + CARD_WIDTH / 2 + n.children[n.children.length - 1].width / 2;
          const blockWidth = lastRight - firstLeft;
          expect(Math.abs(blockWidth - n.width)).toBeLessThan(1);
          expect(Math.abs(firstLeft - bandLeft)).toBeLessThan(1);
          // 兄弟间水平间距一致（= 80，全局统一）
          for (let i = 1; i < n.children.length; i++) {
            const prevRight = n.children[i - 1].x + CARD_WIDTH / 2 + n.children[i - 1].width / 2;
            const curLeft = n.children[i].x + CARD_WIDTH / 2 - n.children[i].width / 2;
            expect(Math.abs(curLeft - prevRight - 80)).toBeLessThan(1);
          }
        }
        check(n.children);
      }
    };
    check(nodes);
  });
});

/**
 * v2.3.2：卡高估算必须**不低于**真实渲染高度。
 *
 * 背景（用户真实数据实测）：岗位名把右侧数字挤成竖排后，岗位行实际渲染 74px，
 * 而常量按 40px 估算 → 每张有岗位的卡片都比估算高，逐层累积后子部门被摆进父卡内部、
 * 引导线被父卡盖住（「六级部门引导线消失、直接盖到五级部门」）。
 *
 * 下面的「真实高度」是用 Chromium 在**用户那份 35 人 / 6 级数据**上量出来的实际 offsetHeight
 * （卡宽 320、成员列表收起态）。断言写成 `估算 ≥ 实测`：
 * 一旦有人把岗位行/成员区常量调小到低于真实值，这里立刻失败 —— 这正是当年漏掉的守卫。
 */
describe('estimateCardHeight 必须 ≥ 真实渲染高度（v2.3.2 布局错乱回归）', () => {
  const emps = (n: number): Employee[] =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `员工${i}`, employeeId: `E${i}`, level: 'L1.1' }));
  const pos = (n: number): Department['positions'] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, departmentId: 'd', name: `岗位${i}`, headcount: 0,
      status: 'active' as const, createdAt: 't', updatedAt: 't',
    }));
  const dept = (employeeCount: number, positionCount: number): Department => ({
    id: 'd', name: '部门', level: 1, children: [], expanded: true,
    employees: emps(employeeCount), positions: pos(positionCount),
  });

  // [员工数, 岗位数, Chromium 实测卡高]
  // 备注列记录实测时该卡的名称形态（名称长度影响卡宽，进而影响是否触发行高变化）
  const MEASURED: [number, number, number][] = [
    [0, 0, 159], // 短英文名
    [1, 1, 225], // 中英混合部门名
    [2, 2, 262], // 中英混合部门名 + 1 岗位
    [3, 3, 302], // 中英混合部门名 + 2 岗位
    [5, 3, 305], // 5 名成员 + 2 岗位（成员行达上限前）
    [15, 2, 262], // 15 名成员（成员列表收起态）
  ];

  it.each(MEASURED)('%i 名员工 / %i 个岗位：估算 ≥ 实测 %i', (empCount, posCount, measured) => {
    expect(estimateCardHeight(dept(empCount, posCount))).toBeGreaterThanOrEqual(measured);
  });

  it('仍然足够紧：估算不得比实测高出 10% 以上（避免层间空白过大）', () => {
    for (const [empCount, posCount, measured] of MEASURED) {
      const est = estimateCardHeight(dept(empCount, posCount));
      expect(est).toBeLessThanOrEqual(measured * 1.1);
    }
  });

  it('卡宽为 320（与 PositionSection / 负责人行的实测排版需求一致）', () => {
    expect(REAL_CARD_WIDTH).toBe(320);
  });
});

/**
 * v2.3.2：卡高的「运行期实测校正」。
 *
 * 估算常量会随 CSS 漂移（正是本次错乱的根因），所以 DOM 量到真实高度时必须优先使用它。
 * 这里用「实测值 ≫ 估算值」的极端输入证明**布局确实读了实测值**，而不是忽略参数。
 */
describe('calculateTreeLayout 使用实测卡高（v2.3.2）', () => {
  const child: Department = {
    id: 'c', name: '子', level: 2, parentId: 'p', children: [], employees: [], expanded: true,
  };
  const parent: Department = {
    id: 'p', name: '父', level: 1, children: [child], employees: [], expanded: true,
  };

  it('实测高度优先：层间步进 = 实测高 + 40（不再用估算）', () => {
    const estimated = estimateCardHeight(parent);
    const measured = new Map([['p', 500]]);
    const nodes = calculateTreeLayout([parent], 0, 0, 100, new Set(), measured);
    expect(measured.get('p')).not.toBe(estimated); // 前提：两者不同，否则断言无判别力
    expect(nodes[0].children[0].y).toBe(500 + 40);
  });

  it('实测值为 0 / 缺失 → 回退估算（jsdom 等无布局环境不能把卡高压成 0）', () => {
    const nodesZero = calculateTreeLayout([parent], 0, 0, 100, new Set(), new Map([['p', 0]]));
    expect(nodesZero[0].children[0].y).toBe(estimateCardHeight(parent) + 40);

    const nodesMissing = calculateTreeLayout([parent], 0, 0, 100, new Set(), new Map([['other', 500]]));
    expect(nodesMissing[0].children[0].y).toBe(estimateCardHeight(parent) + 40);
  });

  it('子卡自身的实测高度也参与其下一层（逐层都用实测）', () => {
    const grand: Department = {
      id: 'g', name: '孙', level: 3, parentId: 'c', children: [], employees: [], expanded: true,
    };
    const p2: Department = { ...parent, children: [{ ...child, children: [grand] }] };
    const measured = new Map([['p', 400], ['c', 300]]);
    const nodes = calculateTreeLayout([p2], 0, 0, 100, new Set(), measured);
    const c = nodes[0].children[0];
    expect(c.y).toBe(440);
    expect(c.children[0].y).toBe(440 + 300 + 40);
  });
});
