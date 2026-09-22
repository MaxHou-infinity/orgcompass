// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DepartmentCard } from './DepartmentCard';
import { CARD_WIDTH } from './OrgChart';
import { computePositionSummary } from '../utils/analytics';
import { DEFAULT_LEVELS } from '../utils/levels';
import type { Department, Employee, Position } from '../types';

/**
 * v2.3.2 岗位行排版不变式（用户实测缺陷回归）。
 *
 * 现象：画布上「岗位数量全是 0」，且三级往下布局错乱、六级引导线被五级卡片盖住。
 * 根因：岗位名（「中文名 - English Full Title」，实测最长 374px）没有 `min-w-0`，
 * 把右侧的「在岗 N / 缺口」数字挤成**每行一个字**，岗位行从 36px 撑到 74px；
 * 而布局按常量估算卡高，于是每一层都算矮了 → 子部门被摆进父卡内部、连线被父卡遮住。
 *
 * jsdom 没有布局引擎，量不到像素，所以这里锁的是**导致换行的结构**本身：
 * 「名字可截断 + 数字簇不可压缩 + 完整名进 title」三者缺一，换行就会回来。
 */

afterEach(cleanup);

const position: Position = {
  id: 'p1', departmentId: 'd1', name: '供应链总监 - Supply Chain Director',
  headcount: 0, status: 'active', createdAt: 't', updatedAt: 't',
};
const employee: Employee = {
  id: 'e1', name: '罗安 Ryan LUO', employeeId: '00494', level: 'L3.2',
  dept1: '技术部', positionId: 'p1',
};
const dept: Department = {
  id: 'd1', name: 'D.A.2 精益制造与品质交付（Agency）', level: 1, expanded: true,
  children: [], employees: [employee], positions: [position],
};
const employees = [employee];

function renderCard(extra: Partial<React.ComponentProps<typeof DepartmentCard>> = {}) {
  const positionSummaries = computePositionSummary([position], employees, DEFAULT_LEVELS);
  return render(
    <DepartmentCard
      department={dept}
      onToggleExpand={vi.fn()}
      onUpdateDepartment={vi.fn()}
      onUpdateLeader={vi.fn()}
      onUpdateLeaderType={vi.fn()}
      onDeleteEmployee={vi.fn()}
      onCreateVirtualFromEmployee={vi.fn()}
      onChangeDepartmentLevel={vi.fn()}
      onSetTargetLevel={vi.fn()}
      onMoveMultiple={vi.fn()}
      allDepartments={[dept]}
      allEmployees={employees}
      positionSummaries={positionSummaries}
      {...extra}
    />,
  );
}

/** 岗位行：以「编制输入框」为锚点向上找行容器 */
function positionRow(): HTMLElement {
  const input = screen.getByLabelText(`${position.name} 编制`);
  return input.closest('div.flex') as HTMLElement;
}

describe('v2.3.2 岗位行排版不变式', () => {
  it('岗位名可截断：min-w-0 + flex-1 + truncate，且完整名进 title（悬停可读全文）', () => {
    renderCard();
    const name = positionRow().querySelector('span.truncate') as HTMLElement;
    expect(name).not.toBeNull();
    expect(name.textContent).toBe(position.name);
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('flex-1');
    // 没有 title 的截断 = 用户永远看不到全名
    expect(name.getAttribute('title')).toBe(position.name);
  });

  it('右侧数字簇不可压缩：shrink-0 + whitespace-nowrap（否则「在岗 N」会被挤成竖排）', () => {
    renderCard();
    const input = screen.getByLabelText(`${position.name} 编制`);
    expect(input.className).toContain('shrink-0');
    const cluster = input.parentElement as HTMLElement;
    expect(cluster.className).toContain('shrink-0');
    expect(cluster.className).toContain('whitespace-nowrap');
  });

  it('「在岗人数」以独立胶囊呈现（这是「这个岗位几个人」的答案，不能被当成 0）', () => {
    renderCard();
    const chip = screen.getByText('在岗 1');
    expect(chip.className).toContain('tabular-nums');
    expect(chip.getAttribute('title')).toContain('自动汇总');
  });

  it('「编制」输入框有 aria-label 与解释性 title（员工表不含编制列，默认 0 需要说清）', () => {
    renderCard();
    const input = screen.getByLabelText(`${position.name} 编制`);
    expect(input.getAttribute('title')).toContain('员工信息表不含编制列');
  });

  it('编制为 0 时明说「未配编制」，不留一个孤零零的 0 让人误解', () => {
    renderCard();
    expect(screen.getByText('未配编制')).toBeDefined();
  });

  it('部门名截断时也带完整名 title', () => {
    renderCard();
    const name = screen.getByText(dept.name);
    expect(name.getAttribute('title')).toContain(dept.name);
  });

  it('卡宽常量 = 320（Chromium 实测：负责人行 194px、最长部门名 247px 需要 ~345px）', () => {
    expect(CARD_WIDTH).toBe(320);
  });
});

/**
 * v2.3.2：部门层级配色必须**逐级可区分**，且卡身不得挂任何带透明度的底色类。
 *
 * 用户反馈：「四级、五级、六级部门卡片的背景颜色是一样的，我希望 4、5、6 级之间要有区分」。
 * 当时四级往下统一兜底到 `.level-bg-1`（与一级同色），十张卡里五张长得一样，层级读不出来。
 * 定稿方案：**只染表头**（与一~三级原有观感一致），色板一靛蓝→二翠绿→三琥珀→四天青→五紫→六玫红。
 *
 * 第二个断言守的是另一个已修缺陷：卡身一旦挂上半透明底色类，引导线就会纵穿卡片。
 */
describe('v2.3.2 部门层级配色', () => {
  const employee: Employee = { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1' };

  function renderAtLevel(level: number) {
    const dept: Department = {
      id: `d${level}`, name: `第${level}级部门`, level, expanded: true,
      children: [], employees: [employee], positions: [],
    };
    const { container } = render(
      <DepartmentCard
        department={dept}
        onToggleExpand={vi.fn()}
        onUpdateDepartment={vi.fn()}
        onUpdateLeader={vi.fn()}
        onUpdateLeaderType={vi.fn()}
        onDeleteEmployee={vi.fn()}
        onCreateVirtualFromEmployee={vi.fn()}
        onChangeDepartmentLevel={vi.fn()}
        onSetTargetLevel={vi.fn()}
        onMoveMultiple={vi.fn()}
        allDepartments={[dept]}
        allEmployees={[employee]}
      />,
    );
    const root = container.querySelector('[data-dept-id]') as HTMLElement;
    const header = container.querySelector('[data-dept-header]') as HTMLElement;
    return { root, header };
  }

  it('一~六级各自有专属表头配色（6 个层级 = 6 种不同配色）', () => {
    const headerClasses = [1, 2, 3, 4, 5, 6].map((lv) => {
      const { header } = renderAtLevel(lv);
      expect(header, `第 ${lv} 级缺少表头元素`).not.toBeNull();
      expect(header.getAttribute('data-dept-header')).toBe(String(lv));
      // 取渐变里的色相类（from-xxx-500/10），这是层级配色的实际载体
      const hue = header.className.match(/from-([a-z]+)-\d+/)?.[1];
      expect(hue, `第 ${lv} 级表头没有色相类：${header.className}`).toBeTruthy();
      cleanup();
      return hue!;
    });
    // 关键：4/5/6 必须互不相同，也不能与 1/2/3 撞色
    expect(new Set(headerClasses).size).toBe(6);
    expect(headerClasses).toEqual(['indigo', 'emerald', 'amber', 'sky', 'purple', 'rose']);
  });

  it('七级及以上有兜底配色（不会因为没有配色而变成无样式表头）', () => {
    const { header } = renderAtLevel(7);
    expect(header.className).toMatch(/from-slate-\d+/);
  });

  it('卡身不挂任何半透明底色类（挂了引导线就会纵穿卡片）', () => {
    for (const lv of [1, 2, 3, 4, 5, 6, 7]) {
      const { root } = renderAtLevel(lv);
      expect(root.className).not.toMatch(/bg-[a-z]+-\d+\/\d+/); // bg-indigo-50/80 这类带透明度的
      expect(root.className).not.toMatch(/level-bg-/);
      cleanup();
    }
  });
});
