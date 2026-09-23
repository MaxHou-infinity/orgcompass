// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppModal } from './AppModal';
import { BatchAssessmentModal } from './BatchAssessmentModal';
import { CompetencyPage } from './CompetencyDrawer';
import { DEFAULT_COMPETENCY_MODEL, Department, Employee, Position } from '../types';
import { isManager } from '../utils/competency';
import { findIndustryTemplate, loadIndustryTemplate } from '../utils/industryTemplates';

afterEach(cleanup);
/** V2.4.0：胜任度已是**页面级**子界面（不再是抽屉弹窗） */
const competencyPage = () => document.querySelector('[data-page="competency"]') as HTMLElement;

const manager: Employee = { id: 'uuid-m', employeeId: 'M001', name: '测试主管', level: 'L3.1' };
const worker: Employee = { id: 'uuid-w', employeeId: 'W001', name: '测试员工', level: 'L1.1' };
const outsider: Employee = { id: 'uuid-o', employeeId: 'O001', name: '其他员工', level: 'L1.1' };
const depts: Department[] = [{ id: 'root', name: '技术部', level: 1, employees: [manager], leaderId: 'M001', expanded: true, children: [
  { id: 'child', name: '研发组', level: 2, employees: [worker], expanded: true, children: [] },
]}, { id: 'other', name: '市场部', level: 1, employees: [outsider], expanded: true, children: [] }];
const employees = [manager, worker, outsider];
function batch() {
  const onSave = vi.fn();
  render(<BatchAssessmentModal open onClose={vi.fn()} departments={depts} allEmployees={employees} allPositions={[]} competencyModel={DEFAULT_COMPETENCY_MODEL} assessments={[]} onSave={onSave} onImportExcel={vi.fn()} />);
  // v2.3 M2：岗位评价默认只覆盖已套岗人员；本组用例未套岗 → 显式选择「通用评价」范围
  fireEvent.click(screen.getByRole('button', { name: '通用评价' }));
  return onSave;
}
/** v2.3 M2：批次经办人（牵头 HRBP）与实际评分人分开留痕，两者均为保存前置条件 */
function fillBatchHeader() {
  fireEvent.change(screen.getByRole('textbox', { name: '牵头 HRBP' }), { target: { value: '体验测试' } });
  fireEvent.change(screen.getByRole('textbox', { name: '上级评分人' }), { target: { value: '上级A' } });
}

describe('体验断点回归', () => {
  it('工号负责人及工号汇报线可以识别干部，虚拟记录不生成干部', () => {
    expect(isManager(manager.id, depts, employees)).toBe(true);
    expect(isManager(manager.id, [], [manager, { ...worker, reportsToEmployeeId: 'M001' }])).toBe(true);
    expect(isManager(manager.id, [], [manager, { ...worker, isVirtual: true, reportsToEmployeeId: 'M001' }])).toBe(false);
  });
  it('真实行业示例有 5 名干部', () => {
    const data = loadIndustryTemplate(findIndustryTemplate('internet')!);
    expect(data.allEmployeesFlat.filter((e) => isManager(e.id, data.departments, data.allEmployeesFlat))).toHaveLength(5);
  });
  it('子部门筛选不会泄漏其他部门人员', () => {
    batch();
    expect(screen.getByText('测试主管')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '员工胜任度' }));
    fireEvent.change(screen.getByRole('combobox', { name: '部门' }), { target: { value: 'child' } });
    expect(screen.getByText('测试员工')).toBeTruthy();
    expect(screen.queryByText('其他员工')).toBeNull();
    expect(screen.queryByText('测试主管')).toBeNull();
  });
  it('数字键覆盖已有分数，保存只接受 1–5 整数', () => {
    const save = batch();
    fillBatchHeader();
    const cell = screen.getByRole('spinbutton', { name: '测试主管 · 战略解码' });
    fireEvent.change(cell, { target: { value: '3' } });
    fireEvent.keyDown(cell, { key: '5' });
    expect((cell as HTMLInputElement).value).toBe('5');
    fireEvent.change(cell, { target: { value: '2.5' } });
    expect((cell as HTMLInputElement).value).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: '保存批次' }));
    expect(save.mock.calls[0][0]).toEqual([expect.objectContaining({ score: 5, employeeId: manager.id })]);
  });
  it('空范围不会声称全员已评', () => {
    batch();
    fireEvent.change(screen.getByRole('combobox', { name: '部门' }), { target: { value: 'other' } });
    expect(screen.queryByText('全员已评')).toBeNull();
    expect(screen.getByText('当前范围没有可评估人员')).toBeTruthy();
  });
  it('汇总下钻包含子部门员工，未评岗位不显示无胜任者', () => {
    const position: Position = { id: 'p', name: '工程师', departmentId: 'child', headcount: 1, status: 'active', createdAt: '', updatedAt: '' };
    const assigned = { ...worker, positionId: 'p' };
    const tree = [{ ...depts[0], children: [{ ...depts[0].children[0], employees: [assigned], positions: [position] }] }];
    render(<CompetencyPage open onClose={vi.fn()} competencySummaries={new Map()} matchStates={[]} departments={tree} allEmployees={[manager, assigned]} allPositions={[position]} onFocusDept={vi.fn()} onOpenDetail={vi.fn()} onStartBatch={vi.fn()} onOpenModelConfig={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /技术部\s*2 人/ }));
    expect(screen.getByText('工程师')).toBeTruthy();
    expect(screen.queryByText('无胜任者')).toBeNull();
    fireEvent.click(screen.getByTitle('展开员工'));
    expect(within(competencyPage()).getByText('测试员工')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看 测试主管 的胜任度详情' })).toBeTruthy();
  });
  it('切换部门后保存包含之前已输入的评分', () => {
    const save = batch();
    fireEvent.click(screen.getByRole('button', { name: '员工胜任度' }));
    fillBatchHeader();
    fireEvent.change(screen.getByRole('combobox', { name: '部门' }), { target: { value: 'child' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '测试员工 · 业务能力' }), { target: { value: '4' } });
    fireEvent.change(screen.getByRole('combobox', { name: '部门' }), { target: { value: 'other' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '其他员工 · 业务能力' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存批次' }));
    expect(save.mock.calls[0][0].map((row: { employeeId: string }) => row.employeeId).sort()).toEqual([outsider.id, worker.id].sort());
  });
  it('按 Esc 关闭前保护未保存输入，继续编辑不丢分', () => {
    batch();
    fireEvent.change(screen.getByRole('spinbutton', { name: '测试主管 · 战略解码' }), { target: { value: '4' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alert').textContent).toContain('尚未保存');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect((screen.getByRole('spinbutton', { name: '测试主管 · 战略解码' }) as HTMLInputElement).value).toBe('4');
  });
  it('嵌套弹窗 Tab 不逃逸，Esc 只关闭顶层', () => {
    const outer = vi.fn(); const inner = vi.fn();
    const { rerender } = render(<AppModal open onClose={outer} title="外层"><button>打开详情</button></AppModal>);
    const opener = screen.getByRole('button', { name: '打开详情' }); opener.focus();
    rerender(<><AppModal open onClose={outer} title="外层"><button>打开详情</button></AppModal><AppModal open onClose={inner} title="内层"><button>完成</button></AppModal></>);
    const dialog = screen.getByRole('dialog', { name: '内层' });
    const last = within(dialog).getByRole('button', { name: '完成' }); last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '关闭' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
  });

});
