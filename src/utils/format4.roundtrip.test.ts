import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Assessment, Department, Employee, Position, ProjectFile } from '../types';
import { COMPETENCY_SCALE, DEFAULT_COMPETENCY_MODEL } from '../types';
import { parseProject, serializeProject, PROJECT_VERSION } from './project';
import { moveDepartmentInTree, levelsById } from './departmentMove';
import { findDeptById } from './departments';

const OUT_DIR = process.env.ORGCOMPASS_EVIDENCE_DIR ?? '.test-artifacts/v2.5.3';
const NOW = '2026-11-14T09:00:00.000Z';

function emp(id: string, name: string, dept1: string): Employee {
  return { id, name, employeeId: id, level: 'L1', dept1 };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return { id, name, level, parentId: opts.parentId, children: opts.children ?? [], employees: opts.employees ?? [], expanded: true, positions: opts.positions, ...opts };
}

function buildFixture(): ProjectFile {
  const pos: Position = {
    id: 'pos-keep',
    departmentId: 'X',
    name: '无关岗位-保留',
    headcount: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const ex = emp('EX', '旁支员工', 'X');
  const assessment: Assessment = {
    id: 'asm-keep',
    employeeId: 'EX',
    positionId: 'pos-keep',
    dimension: 'business',
    score: 4,
    scale: COMPETENCY_SCALE,
    requirement: 3,
    assessorRole: 'supervisor',
    assessedAt: NOW,
    assessmentDay: '2026-11-01',
    source: 'manual',
    note: '与本轮调整无关的评价，必须保全',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const tree: Department[] = [
    dept('A', 'A', 1, {
      employees: [emp('EA', '甲', 'A')],
      children: [
        dept('B', 'B', 2, {
          parentId: 'A',
          employees: [emp('EB', '乙', 'B')],
          children: [dept('C', 'C', 3, { parentId: 'B', employees: [emp('EC', '丙', 'C')] })],
        }),
      ],
    }),
    dept('X', 'X', 1, {
      employees: [ex],
      positions: [pos],
      children: [
        dept('Y', 'Y', 2, {
          parentId: 'X',
          children: [dept('Z', 'Z', 3, { parentId: 'Y' })],
        }),
      ],
    }),
  ];
  return {
    id: 'proj-f4-c01',
    name: '格式4虚构往返夹具',
    version: 4,
    currentScenarioId: 'sc-base',
    scenarios: [
      {
        id: 'sc-base',
        name: '基线',
        createdAt: NOW,
        updatedAt: NOW,
        departments: tree,
        allEmployeesFlat: [emp('EA', '甲', 'A'), emp('EB', '乙', 'B'), emp('EC', '丙', 'C'), ex],
        levelConfigs: [{ code: 'L', number: '1', label: '一级', color: '#334155', cost: 4 }],
        canvas: { zoom: 100 },
        competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
        assessments: [assessment],
        positionAssignments: [],
        positions: [pos],
      },
    ],
    levelConfigs: [{ code: 'L', number: '1', label: '一级', color: '#334155', cost: 4 }],
    meta: { createdAt: NOW, updatedAt: NOW, version: 4 },
  };
}

function save(name: string, raw: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${name}`;
  writeFileSync(file, raw);
  const sha = createHash('sha256').update(raw).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha}  ${name}\n`);
  return { file, sha };
}

describe('格式 4 合法虚构项目往返（A-F4 / XR-03）', () => {
  it('打开 / 调整 / 保存 / 恢复 / 刷新：无需迁移，ID/归属/层级及无关岗位评价保全', () => {
    expect(PROJECT_VERSION).toBe(4);
    const original = buildFixture();
    const openedRaw = serializeProject(original);
    const openedHash = save('format4-open.orgproj', openedRaw);
    const opened = parseProject(openedRaw);
    expect(opened).not.toBeNull();
    expect(opened!.version).toBe(4);
    expect(opened!.meta.version).toBe(4);
    expect(opened!.scenarios[0].id).toBe('sc-base');

    const beforeIds = ['A', 'B', 'C', 'X', 'Y', 'Z'];
    const moved = moveDepartmentInTree(opened!.scenarios[0].departments, 'B', 'Z');
    expect(moved.moved).toBe(true);
    expect(levelsById(moved.departments)).toMatchObject({ A: 1, B: 4, C: 5, X: 1, Y: 2, Z: 3 });

    const adjusted: ProjectFile = {
      ...opened!,
      scenarios: [{
        ...opened!.scenarios[0],
        departments: moved.departments,
        updatedAt: '2026-11-14T09:10:00.000Z',
      }],
      meta: { ...opened!.meta, updatedAt: '2026-11-14T09:10:00.000Z' },
    };
    const savedRaw = serializeProject(adjusted);
    const savedHash = save('format4-after-c01-move.orgproj', savedRaw);
    expect(JSON.parse(savedRaw).version).toBe(4);

    const restored = parseProject(savedRaw);
    expect(restored).not.toBeNull();
    expect(restored!.version).toBe(4);
    expect(restored!.meta.version).toBe(4);
    expect(levelsById(restored!.scenarios[0].departments)).toMatchObject({ A: 1, B: 4, C: 5, X: 1, Y: 2, Z: 3 });
    for (const id of beforeIds) {
      expect(findDeptById(restored!.scenarios[0].departments, id)?.id).toBe(id);
    }
    const assessments = restored!.scenarios[0].assessments ?? [];
    expect(assessments).toHaveLength(1);
    expect(assessments[0].id).toBe('asm-keep');
    expect(assessments[0].note).toBe('与本轮调整无关的评价，必须保全');
    expect(assessments[0].score).toBe(4);
    const pos = restored!.scenarios[0].departments
      .flatMap(function walk(d: Department): import("../types").Position[] { return [...(d.positions ?? []), ...d.children.flatMap(walk)]; });
    expect(pos.some((p) => p.id === 'pos-keep' && p.name === '无关岗位-保留')).toBe(true);

    const refreshed = parseProject(serializeProject(restored!));
    expect(refreshed).not.toBeNull();
    expect(refreshed!.version).toBe(4);
    expect(levelsById(refreshed!.scenarios[0].departments)).toMatchObject({ B: 4, C: 5 });
    expect(refreshed!.scenarios[0].assessments?.[0].id).toBe('asm-keep');
    const refreshHash = save('format4-after-refresh.orgproj', serializeProject(refreshed!));

    expect(openedHash.sha).toHaveLength(64);
    expect(savedHash.sha).toHaveLength(64);
    expect(refreshHash.sha).toHaveLength(64);
  });
});
