// @vitest-environment jsdom
/**
 * v2.2.0 组件级交互冒烟测试（视觉回归的 headless 补充层）：
 * 验证 4 个新组件 + 胜任度环/胶囊在真实渲染下不崩溃、关键 UI 文案与状态呈现正确。
 * 视觉细节仍以真实浏览器回归为准（dev server http://127.0.0.1:5173）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CompetencyRing, CompetencyCapsule, CompetencyDrawer } from './CompetencyDrawer';
import { BatchAssessmentModal } from './BatchAssessmentModal';
import { CompetencyDetailModal } from './CompetencyDetailModal';
import { CompetencyModelModal } from './CompetencyModelModal';
import { DEFAULT_COMPETENCY_MODEL, COMPETENCY_SCALE } from '../types';
import type {
  Employee,
  Department,
  Position,
  Assessment,
  CompetencySummary,
  LeadershipDossier,
  MatchResult,
} from '../types';

afterEach(cleanup); // testing-library 默认不自动清理（vitest globals 关闭），显式清理防 DOM 累积

const NOW = '2026-08-29T00:00:00.000Z';

function emp(id: string, name: string, level = 'L2.1'): Employee {
  return { id, name, employeeId: `E${id}`, level };
}

// 张三（e1）是管理者：李四（e2）直管指向 e1 → isManager('e1') = true（领导力评估范围默认只看管理者）
const depts: Department[] = [
  {
    id: 'd1',
    name: '研发部',
    level: 1,
    expanded: true,
    children: [],
    employees: [emp('e1', '张三'), { ...emp('e2', '李四'), reportsToEmployeeId: 'e1' }],
  },
];

const employees: Employee[] = [emp('e1', '张三'), { ...emp('e2', '李四'), reportsToEmployeeId: 'e1' }];

const positions: Position[] = [
  { id: 'p1', departmentId: 'd1', name: '前端工程师', headcount: 2, status: 'active', createdAt: NOW, updatedAt: NOW },
];

const matchStates: MatchResult[] = [
  { employeeId: 'e1', status: 'placed', positionId: 'p1' },
  { employeeId: 'e2', status: 'placed', positionId: 'p1' },
];

const assessments: Assessment[] = [];

const asm: Assessment = {
  id: 'asm1',
  employeeId: 'e1',
  positionId: 'p1',
  dimension: 'business',
  score: 2,
  scale: COMPETENCY_SCALE,
  requirement: 3,
  assessorRole: 'supervisor',
  assessorId: 'a1',
  assessedAt: NOW,
  source: 'manual',
  createdAt: NOW,
  updatedAt: NOW,
};

const summary: CompetencySummary = {
  employeeId: 'e1',
  group: 'staff',
  dimensions: [
    { dimension: 'business', label: '业务能力', definition: '岗位专业深度', group: 'staff', score: 2, requirement: 3, gap: 1, status: 'warn', assessmentId: 'asm1', assessedAt: NOW, applicability: 'current', revised: false, duplicate: false, hrbpCalibration: null },
    { dimension: 'individual', label: '单兵能力', definition: '自驱学习', group: 'staff', score: 4, requirement: 3, gap: -1, status: 'healthy', assessmentId: 'asm2', assessedAt: NOW, applicability: 'current', revised: false, duplicate: false, hrbpCalibration: null },
  ],
  overall: { score: 3, gap: 0, worstGap: 1, status: 'warn' },
  notCompetentCandidate: false,
  assessedBy: ['a1'],
  latestAssessedAt: NOW,
  completeness: { status: 'complete', expected: 2, assessed: 2, conflicted: [], historical: [], qualified: false, computable: true, dataIssue: false },
};

const dossier: LeadershipDossier = {
  employeeId: 'e1',
  targetLevel: 'L3.2',
  dimensions: [
    { dimension: 'leadership_strategy', label: '战略解码', definition: '目标拆解', group: 'leadership', score: 4, requirement: 3, gap: -1, status: 'healthy', assessmentId: 'asm3', assessedAt: NOW, applicability: 'current', revised: false, duplicate: false, hrbpCalibration: null },
  ],
  overall: { score: 4, gap: -1, worstGap: -1, status: 'healthy' },
};

const history: ReturnType<typeof import('../utils/competency').listAssessmentHistory> = [
  { dimension: 'business', label: '业务能力', definition: '岗位专业深度', enabled: true, orphan: false, group: 'staff', records: [asm] },
];

describe('v2.2.0 组件交互冒烟', () => {
  it('CompetencyRing 四态渲染正确的 aria-label（形状/图标承载，色盲友好）', () => {
    render(<CompetencyRing status="healthy" score={4} threshold={3} />);
    expect(screen.getByLabelText('胜任度：胜任')).toBeTruthy();
    render(<CompetencyRing status="warn" />);
    expect(screen.getByLabelText('胜任度：待提升')).toBeTruthy();
    render(<CompetencyRing status="danger" score={2} />);
    expect(screen.getByLabelText('胜任度：待复核')).toBeTruthy();
    render(<CompetencyRing status="unrated" />);
    expect(screen.getByLabelText('胜任度：未评分')).toBeTruthy();
  });

  it('CompetencyCapsule 展开态带分值', () => {
    render(<CompetencyCapsule status="healthy" score={4} />);
    expect(screen.getByText(/4/)).toBeTruthy();
  });

  it('CompetencyDrawer 渲染图例 + 部门卡 + 未评统计（未评=中性灰不伪装）', () => {
    const onClose = vi.fn();
    render(
      <CompetencyDrawer
        open
        onClose={onClose}
        competencySummaries={new Map()}
        matchStates={matchStates}
        departments={depts}
        allEmployees={employees}
        allPositions={positions}
        onFocusDept={vi.fn()}
        onOpenDetail={vi.fn()}
        onStartBatch={vi.fn()}
        onOpenModelConfig={vi.fn()}
        onConfirmNotCompetent={vi.fn()}
        confirmedNotCompetent={new Set()}
      />,
    );
    expect(screen.getByText('图例')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    // 未评分/未评以中性灰呈现（不伪装绿/红）
    expect(screen.getAllByText(/未评/).length).toBeGreaterThan(0);
  });

  it('BatchAssessmentModal 渲染维度列网格（默认预设 6 维）与未评态', () => {
    // v2.3 M2：岗位评价默认只覆盖已套岗人员 → 本用例走「通用评价」显式范围
    render(
      <BatchAssessmentModal
        open
        onClose={vi.fn()}
        departments={depts}
        allEmployees={employees}
        allPositions={positions}
        competencyModel={DEFAULT_COMPETENCY_MODEL}
        assessments={assessments}
        onSave={vi.fn()}
        onImportExcel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '通用评价' }));
    // 干部 4 维列头
    expect(screen.getByText('战略解码')).toBeTruthy();
    expect(screen.getByText('带队育人')).toBeTruthy();
    expect(screen.getByText('结果担当')).toBeTruthy();
    expect(screen.getByText('协同影响')).toBeTruthy();
    // 管理者行出现（默认评估范围=领导力/管理者）
    expect(screen.getByText('张三')).toBeTruthy();
    // 未评态文字（不伪装分数）
    expect(screen.getAllByText(/未评/).length).toBeGreaterThan(0);
  });

  it('CompetencyDetailModal 展示分维度/Gap/基准 + 干部定级依据只读块（不自动定级）', () => {
    render(
      <CompetencyDetailModal
        open
        onClose={vi.fn()}
        employee={emp('e1', '张三')}
        position={positions[0]}
        summary={summary}
        dossier={dossier}
        history={history}
        resolveName={(id) => (id === 'a1' ? '王HRBP' : '?')}
      />,
    );
    // 维度名在分值表与基准说明等多处出现 → 用 getAllByText
    expect(screen.getAllByText(/业务能力/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/单兵能力/).length).toBeGreaterThan(0);
    // 定级依据块显式标注「不自动定级/晋升」（红线）
    expect(screen.getByText(/定管理职级依据/)).toBeTruthy();
    expect(screen.getByText(/本工具不自动定级/)).toBeTruthy();
  });

  it('CompetencyModelModal 渲染维度配置 + 恢复默认预设入口', () => {
    render(
      <CompetencyModelModal
        open
        onClose={vi.fn()}
        model={DEFAULT_COMPETENCY_MODEL}
        assessments={assessments}
        onSave={vi.fn()}
      />,
    );
    // 维度 label 渲染为输入框 value（可编辑）→ getByDisplayValue
    expect(screen.getByDisplayValue('战略解码')).toBeTruthy();
    expect(screen.getAllByText('领导力（干部）').length).toBeGreaterThan(0);
    expect(screen.getByText('恢复默认预设')).toBeTruthy();
  });
});
