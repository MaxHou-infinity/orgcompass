import { useState, useEffect } from 'react';
import { JOB_FAMILY_OPTIONS } from '../utils/managementBenchmarks';
import { AppModal } from './AppModal';
import { fullCode } from '../utils/level';
import type { Department, LevelConfig } from '../types';

export interface PositionCreateFields {
  name: string;
  jobFamily?: string;
  levelBandMin?: string;
  levelBandMax?: string;
  headcount?: number;
}

/** 岗位序列（jobFamily）可选项 —— 与 route map 文档对齐。 */
const JOB_FAMILIES: readonly string[] = JOB_FAMILY_OPTIONS;

/**
 * 「新建岗位」应用内弹窗（v2.1.1，替代 PositionSection 内联短表单）。
 * 采集岗位名 + 序列 + 职级带宽下限/上限 + 编制数；编制数缺省 0（未配置，不伪装满编）。
 */
export function PositionModal({
  open,
  onClose,
  dept,
  levelConfigs,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  dept: Department;
  levelConfigs: LevelConfig[];
  onCreate: (deptId: string, fields: PositionCreateFields) => void;
}) {
  const [name, setName] = useState('');
  const [jobFamily, setJobFamily] = useState('');
  const [bandMin, setBandMin] = useState('');
  const [bandMax, setBandMax] = useState('');
  const [headcount, setHeadcount] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setJobFamily('');
      setBandMin('');
      setBandMax('');
      setHeadcount('');
    }
  }, [open]);

  const levelOptions = levelConfigs.map((c) => ({ value: fullCode(c), label: fullCode(c) }));
  const valid = name.trim().length > 0;

  const create = () => {
    if (!valid) return;
    onCreate(dept.id, {
      name: name.trim(),
      jobFamily: jobFamily || undefined,
      levelBandMin: bandMin || undefined,
      levelBandMax: bandMax || undefined,
      headcount: headcount === '' ? 0 : Number(headcount),
    });
    onClose();
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={`新建岗位 · ${dept.name}`}
      subtitle="岗位 = 编制名额的载体；编制数缺省 0（未配置，不判超编）"
      footer={
        <>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            onClick={create}
            disabled={!valid}
            className="px-4 py-1.5 rounded-lg text-sm text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            创建岗位
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-slate-500">岗位名称 <span className="text-red-500">*</span></span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') onClose(); }}
            placeholder="如 前端工程师"
            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">岗位序列（jobFamily）</span>
            <select value={jobFamily} onChange={(e) => setJobFamily(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring">
              <option value="">（未指定）</option>
              {JOB_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">编制数</span>
            <input
              type="number" min="0" step="1" value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
              placeholder="0 = 未配置"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">职级带宽下限</span>
            <select value={bandMin} onChange={(e) => setBandMin(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring">
              <option value="">（不限）</option>
              {levelOptions.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">职级带宽上限</span>
            <select value={bandMax} onChange={(e) => setBandMax(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring">
              <option value="">（不限）</option>
              {levelOptions.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
            </select>
          </label>
        </div>
      </div>
    </AppModal>
  );
}
