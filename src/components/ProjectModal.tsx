import { useDialogFocus } from '../utils/useDialogFocus';
import { useRef, useState } from 'react';
import { X, FileDown, FileUp, Plus, Copy, Trash2, Check, FolderOpen, Pencil, AlertTriangle, History } from 'lucide-react';
import { ProjectFile } from '../types';
import type { ProjectBackupInfo } from '../utils/project';

interface ProjectModalProps {
  open: boolean;
  onClose: () => void;
  project: ProjectFile;
  currentScenarioId: string;
  onRenameProject: (name: string) => void;
  onCreateScenario: (name: string) => void;
  onRenameScenario: (id: string, name: string) => void;
  onDeleteScenario: (id: string) => void;
  onDuplicateScenario: (id: string) => void;
  onSwitchScenario: (id: string) => void;
  onImport: (json: string) => void;
  onExport: () => void;
  /** v2.3.1 F-12：列出现有可恢复快照 */
  onListBackups: () => ProjectBackupInfo[];
  /** v2.3.1 F-12：恢复某一份快照 */
  onRestoreBackup: (key: string) => void;
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN');
}

/**
 * v2.3.1（F-12）历史快照区：导入 .orgproj / 清空工作区 / 恢复快照前，
 * 系统都会把当时的自动保存原样留档，这里提供可恢复入口 —— 否则「有备份但拿不回来」。
 */
function BackupSection({
  onListBackups,
  onRestoreBackup,
}: {
  onListBackups: () => ProjectBackupInfo[];
  onRestoreBackup: (key: string) => void;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const backups = onListBackups();
  return (
    <section>
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
        <History className="w-3.5 h-3.5" />
        历史快照（{backups.length}）
      </h3>
      {backups.length === 0 ? (
        <p className="text-xs text-slate-400">
          暂无快照。导入 .orgproj、清空工作区或恢复快照时，系统会自动把当时的工作区留档（保留最近 5 份）。
        </p>
      ) : (
        <ul className="space-y-2">
          {backups.map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-600">
                <div className="font-medium text-slate-700">{fmtTime(b.at)}</div>
                <div className="text-slate-400">{b.reason}</div>
              </div>
              {pendingKey === b.key ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPendingKey(null)}
                    className="px-2.5 py-1 rounded-lg text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => {
                      setPendingKey(null);
                      onRestoreBackup(b.key);
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                  >
                    确认恢复
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setPendingKey(b.key)}
                  className="px-2.5 py-1 rounded-lg text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  恢复这一份
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {pendingKey && (
        <p role="alert" className="mt-2 text-xs text-amber-700">
          恢复会用该快照整体替换当前工作区（恢复前会再把当前状态留一份快照，可再次回退）。
        </p>
      )}
    </section>
  );
}

export function ProjectModal({
  open,
  onClose,
  project,
  currentScenarioId,
  onRenameProject,
  onCreateScenario,
  onRenameScenario,
  onDeleteScenario,
  onDuplicateScenario,
  onSwitchScenario,
  onImport,
  onExport,
  onListBackups,
  onRestoreBackup,
}: ProjectModalProps) {
  const dialogRef = useDialogFocus(open, onClose);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // v2.3.1（F-12）：导入前二次确认（整体替换当前工作区，且此前无备份）
  const [confirmImportOpen, setConfirmImportOpen] = useState(false);
  // v2.1.1：场景内联重命名（替代原生 window.prompt）
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  if (!open) return null;

  const handleFileChosen = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === 'string') onImport(text);
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fadeIn" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="项目管理" tabIndex={-1} className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-3xl bg-white/90 backdrop-blur-xl border border-white/40 shadow-2xl overflow-hidden animate-fadeInUp">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-indigo-500/5 to-transparent">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            项目管理
            <span className="text-xs font-normal text-slate-400">场景 / 项目文件 / 备份</span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* 项目信息 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">项目信息</h3>
            <label className="block text-xs text-slate-500 mb-1">项目名</label>
            <input
              type="text"
              defaultValue={project.name}
              onBlur={(e) => onRenameProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus-ring"
            />
            <div className="flex gap-4 mt-2 text-xs text-slate-400">
              <span>创建：{fmtTime(project.meta.createdAt)}</span>
              <span>最近保存：{fmtTime(project.meta.updatedAt)}</span>
              <span>数据版本：v{project.version}</span>
            </div>
          </section>

          {/* 场景列表 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                场景（{project.scenarios.length}）
              </h3>
              <button
                onClick={() => onCreateScenario(`场景 ${project.scenarios.length + 1}`)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                新建场景
              </button>
            </div>
            <div className="space-y-2">
              {project.scenarios.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-colors ${
                    s.id === currentScenarioId ? 'border-indigo-300 bg-indigo-50/60' : 'border-slate-100 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                      {s.id === currentScenarioId && <Check className="w-3.5 h-3.5 text-indigo-500 shrink-0" />}
                      {renameId === s.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (renameValue.trim()) onRenameScenario(s.id, renameValue.trim());
                              setRenameId(null);
                            } else if (e.key === 'Escape') {
                              setRenameId(null);
                            }
                          }}
                          onBlur={() => {
                            if (renameValue.trim()) onRenameScenario(s.id, renameValue.trim());
                            setRenameId(null);
                          }}
                          className="w-full min-w-0 px-1.5 py-0.5 border border-indigo-300 rounded text-sm focus-ring"
                        />
                      ) : (
                        <span className="truncate">{s.name}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {s.departments.length} 个部门 · {s.allEmployeesFlat.length} 名员工 · {fmtTime(s.updatedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {s.id !== currentScenarioId && (
                      <button
                        onClick={() => onSwitchScenario(s.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-indigo-600 transition-colors"
                        title="切换到此场景"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setRenameId(s.id);
                        setRenameValue(s.name);
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                      title="重命名"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDuplicateScenario(s.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                      title="复制"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (project.scenarios.length <= 1) return;
                        if (confirm(`确定删除场景「${s.name}」？此操作不可恢复。`)) {
                          onDeleteScenario(s.id);
                        }
                      }}
                      disabled={project.scenarios.length <= 1}
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 项目文件 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">项目文件 (.orgproj)</h3>
            <p className="text-xs text-slate-400 mb-3">
              保存为 .orgproj 项目文件（含全部场景 / 职级 / 编制成本 / 配色），便于备份与分享。
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={onExport}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors shadow-sm"
              >
                <FileDown className="w-4 h-4" />
                另存为 .orgproj
              </button>
              <button
                onClick={() => setConfirmImportOpen(true)}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-colors"
              >
                <FileUp className="w-4 h-4" />
                导入 .orgproj
              </button>
            </div>
            {/* v2.3.1（F-12）：导入会整体替换当前工作区 → 先确认，并提示先导出备份 */}
            {confirmImportOpen && (
              <div role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold">导入会整体替换当前工作区</p>
                    <p>
                      当前 {project.scenarios.length} 个场景会被导入文件中的场景取代（系统会先自动留一份可恢复快照）。
                      如需保留现有内容的独立文件，请先「另存为 .orgproj」。
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => setConfirmImportOpen(false)}
                    className="px-3 py-1.5 rounded-lg border border-amber-200 bg-white text-amber-900 hover:bg-amber-100 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => {
                      setConfirmImportOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                  >
                    继续导入
                  </button>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".orgproj,application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileChosen(file);
              }}
            />
          </section>

          {/* v2.3.1（F-12）：历史快照 —— 导入 / 清空 / 恢复前都会自动留档，可回退 */}
          <BackupSection onListBackups={onListBackups} onRestoreBackup={onRestoreBackup} />
        </div>

        <div className="flex items-center justify-end px-6 py-4 border-t border-slate-100 bg-slate-50/50">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 border border-slate-200 hover:bg-slate-100 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
