import { Upload, Download, FileSpreadsheet, Image, Plus, Building2, Activity, FileJson, FileText, RefreshCw, Eye, FolderOpen } from 'lucide-react';
import { Department } from '../types';
import { useState } from 'react';
import { useDisplaySettings, setDisplaySetting } from '../utils/displaySettings';
import { validateImportFile, getImportErrorMessage, WARN_IMPORT_FILE_BYTES } from '../utils/excel';

interface SidebarProps {
  onEmployeeFileUpload: (file: File) => void;
  onOrgTemplateUpload: (file: File) => void;
  onExportPng: () => void;
  onExportExcel: () => void;
  onReset: () => void;
  onLoadTestData: () => void;
  onCreateDepartment: (name: string, level: number, parentId: string | null, leaderId?: string, leaderName?: string) => void;
  onOpenHealth: () => void;
  onOpenReport: () => void;
  onExportProject: () => void;
  /** v2.3.2：从 .orgproj 恢复（与「数据备份」并排，避免「有备份但找不到恢复入口」） */
  onRestoreProject: () => void;
  onRefreshCanvas: () => void;
  departments: Department[];
  hasData: boolean;
  /** 是否已成功上传员工信息 / 组织架构（用于显示 已载入/未载入 状态条） */
  hasEmployees: boolean;
  hasOrgTemplate: boolean;
}

export function Sidebar({
  onEmployeeFileUpload,
  onOrgTemplateUpload,
  onExportPng,
  onExportExcel,
  onReset,
  onLoadTestData,
  onCreateDepartment,
  onOpenHealth,
  onOpenReport,
  onExportProject,
  onRestoreProject,
  onRefreshCanvas,
  departments,
  hasData,
  hasEmployees,
  hasOrgTemplate,
}: SidebarProps) {
  const [showCreateDept, setShowCreateDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptLevel, setNewDeptLevel] = useState(1);
  const [newDeptParent, setNewDeptParent] = useState<string | null>('root');
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const { showLevel, showTitle } = useDisplaySettings();

  /** 文件选择护栏：先做扩展名/大小前置校验，非法即提示并中止，不进入解析；超软阈值给「可能变慢」提醒。 */
  const handleFileSelect = (file: File, kind: 'employee' | 'org') => {
    const v = validateImportFile(file);
    if (!v.ok) {
      setImportError(getImportErrorMessage(v.error));
      setImportNotice(null);
      return;
    }
    setImportError(null);
    setImportNotice(file.size > WARN_IMPORT_FILE_BYTES ? '文件较大，处理可能变慢' : null);
    if (kind === 'employee') onEmployeeFileUpload(file);
    else onOrgTemplateUpload(file);
  };

  const handleCreateDept = () => {
    if (!newDeptName.trim()) return;
    onCreateDepartment(newDeptName, newDeptLevel, newDeptParent);
    setNewDeptName('');
    setNewDeptLevel(1);
    setNewDeptParent('root');
    setShowCreateDept(false);
  };

  // 收集所有部门用于选择父部门
  const flattenDepts = (depts: Department[], prefix = ''): { id: string; name: string }[] => {
    let result: { id: string; name: string }[] = [];
    depts.forEach(dept => {
      result.push({ id: dept.id, name: prefix + dept.name });
      if (dept.children.length > 0) {
        result = result.concat(flattenDepts(dept.children, prefix + '  '));
      }
    });
    return result;
  };
  const allDepts = flattenDepts(departments);
  return (
    <div className="workspace-sidebar flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* 文件上传：两行状态条（已载入 / 未载入），点击即触发上传 */}
        <div className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5 text-indigo-500" />
            文件上传
          </h2>

          <div className="space-y-1.5">
            <label
              title="画布主结构来源：上传员工信息表即可生成完整组织架构图（部门按「一~六级部门」列自动建树）"
              className="flex items-center gap-2 px-2.5 py-1.5 bg-white/70 border border-slate-200 rounded-lg cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/50 transition-all group"
            >
              <FileSpreadsheet className={`w-3.5 h-3.5 shrink-0 ${hasEmployees ? 'text-emerald-500' : 'text-slate-300 group-hover:text-indigo-500'}`} />
              <span className="flex-1 min-w-0 text-xs text-slate-600">员工信息</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${hasEmployees ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                {hasEmployees ? '已载入' : '未载入'}
              </span>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) handleFileSelect(file, 'employee');
                }}
              />
            </label>

            {/* v2.3.2：组织架构表从「唯一依据」降级为「补充层」——只补员工表装不下的两件事：
                没有任何员工的空部门、部门负责人。徽标此前误用「有没有部门」判断，永远显示已载入。 */}
            <label
              title="可选补充层：只补「无人的空部门」与「部门负责人」；员工、岗位、编制、评分均不受影响，重复上传按可替换处理"
              className="flex items-center gap-2 px-2.5 py-1.5 bg-white/70 border border-slate-200 rounded-lg cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/50 transition-all group"
            >
              <FileSpreadsheet className={`w-3.5 h-3.5 shrink-0 ${hasOrgTemplate ? 'text-emerald-500' : 'text-slate-300 group-hover:text-emerald-500'}`} />
              <span className="flex-1 min-w-0 text-xs text-slate-600">
                组织架构<span className="text-[10px] text-slate-400">（补充）</span>
              </span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${hasOrgTemplate ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                {hasOrgTemplate ? '已载入' : '未载入'}
              </span>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) handleFileSelect(file, 'org');
                }}
              />
            </label>
          </div>

          {/* 导入护栏提示 + 本地处理微文案 */}
          <div className="space-y-1.5">
            {importError && (
              <div className="px-2.5 py-1.5 bg-rose-50 border border-rose-200 rounded-lg text-[11px] leading-snug text-rose-700">
                {importError}
              </div>
            )}
            {importNotice && (
              <div className="px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] leading-snug text-amber-700">
                {importNotice}
              </div>
            )}
            <p className="px-1 text-[10px] leading-snug text-slate-500">
              本机处理，数据不出设备；导入前会做基本格式与大小校验。
            </p>
          </div>

          <button
            onClick={onRefreshCanvas}
            disabled={!hasData}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs font-medium"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新画布
          </button>
        </div>

        {/* 画布显示设置 */}
        <div className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-indigo-500" />
            画布显示
          </h2>
          <label className="flex items-center justify-between px-2.5 py-1.5 bg-white/70 border border-slate-200 rounded-lg cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/50 transition-all">
            <span className="text-xs text-slate-600">显示职级</span>
            <input
              type="checkbox"
              checked={showLevel}
              onChange={(e) => setDisplaySetting('showLevel', e.target.checked)}
              className="accent-indigo-500 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between px-2.5 py-1.5 bg-white/70 border border-slate-200 rounded-lg cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/50 transition-all">
            <span className="text-xs text-slate-600">显示岗位 / 说明</span>
            <input
              type="checkbox"
              checked={showTitle}
              onChange={(e) => setDisplaySetting('showTitle', e.target.checked)}
              className="accent-indigo-500 w-4 h-4"
            />
          </label>
        </div>

        {/* 导出功能 */}
        <div className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5 text-indigo-500" />
            导出
          </h2>

          <div className="space-y-1.5">
            <button
              onClick={onExportPng}
              disabled={!hasData}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Image className="w-3.5 h-3.5" />
              导出PNG
            </button>
            <button
              onClick={onExportExcel}
              disabled={!hasData}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              导出Excel
            </button>
          </div>
        </div>

        {/* 分析 & 备份 */}
        <div className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-indigo-500" />
            分析 & 备份
          </h2>
          <div className="space-y-1.5">
            <button
              onClick={onOpenHealth}
              disabled={!hasData}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Activity className="w-3.5 h-3.5" />
              组织健康度
            </button>
            <button
              onClick={onOpenReport}
              disabled={!hasData}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              诊断报告
            </button>
            <button
              onClick={onExportProject}
              disabled={!hasData}
              title="把整个工作区（全部场景 / 部门 / 岗位编制 / 职级 / 评分 / 任职记录）另存为一个 .orgproj 文件，可换机、重装、长期归档。注意：它只写文件，不写入下方「历史快照」。"
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <FileJson className="w-3.5 h-3.5" />
              数据备份 (.orgproj)
            </button>
            {/*
              v2.3.2：备份的"回程"入口必须和备份挨着。
              此前恢复只存在于「场景下拉 → 管理场景 → 项目文件」四步深处，
              用户点完「数据备份」根本找不到怎么恢复 —— 反馈原话「备份了之后似乎没有办法恢复」。
            */}
            <button
              onClick={onRestoreProject}
              title="从 .orgproj 文件恢复整个工作区（会先自动留一份可回退快照）"
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-sm"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              从 .orgproj 恢复
            </button>
          </div>
        </div>

        {/* 创建部门 */}
        <div className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-indigo-500" />
            创建部门
          </h2>

          {!showCreateDept ? (
            <button
              onClick={() => setShowCreateDept(true)}
              className="w-full px-3 py-1.5 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded-lg text-xs font-medium hover:bg-indigo-100 transition-colors flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              新建部门
            </button>
          ) : (
            <div className="space-y-1.5 p-2 bg-slate-50 rounded-lg border border-slate-100">
              <input
                type="text"
                placeholder="部门名称"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs focus-ring"
              />
              <select
                value={newDeptLevel}
                onChange={(e) => setNewDeptLevel(Number(e.target.value))}
                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs focus-ring"
              >
                <option value={1}>L1 (一级部门)</option>
                <option value={2}>L2 (二级部门)</option>
                <option value={3}>L3 (三级部门)</option>
                <option value={4}>L4 (四级部门)</option>
                <option value={5}>L5 (五级部门)</option>
                <option value={6}>L6 (六级部门)</option>
              </select>
              <select
                value={newDeptParent || 'root'}
                onChange={(e) => setNewDeptParent(e.target.value === 'root' ? null : e.target.value)}
                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs focus-ring"
              >
                <option value="root">无 (根级别)</option>
                {allDepts.map(dept => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <button
                  onClick={handleCreateDept}
                  className="flex-1 px-2 py-1.5 bg-indigo-500 text-white rounded-lg text-xs font-medium hover:bg-indigo-600 transition-colors"
                >
                  创建
                </button>
                <button
                  onClick={() => setShowCreateDept(false)}
                  className="flex-1 px-2 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-300 transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/*
          原「职级颜色」图例已移除（v2.3.2）。
          理由：右上角「职级管理」里每个职级就带色块，改色也在那里改；侧栏这份只是静态复述，
          既不能点也不能改，纯占位。去掉后侧栏更短，且不存在"两处色块不一致"的观感风险。
        */}

        {/* 使用说明 */}
        <div className="space-y-1.5 text-[11px] text-slate-500">
          <h3 className="font-semibold text-slate-700">使用说明</h3>
          <ul className="list-disc list-inside space-y-0.5">
            <li>上传员工 Excel 即可生成组织架构图</li>
            <li>组织架构表为可选补充（空部门 / 负责人）</li>
            <li>拖拽员工到不同部门</li>
            <li>双击编辑部门名称</li>
            <li>点击负责人搜索选择员工</li>
            <li>右键创建/删除虚拟员工</li>
            <li>捏合 / Ctrl+滚轮缩放 · 双指滑动或拖拽空白区平移</li>
          </ul>
        </div>
      </div>

      {/* 测试数据按钮 */}
      <div className="p-3 border-t border-slate-200 bg-white">
        <button
          onClick={onLoadTestData}
          className="w-full px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium mb-1.5 shadow-md"
        >
          载入示例数据
        </button>
        <button
          onClick={onReset}
          className="w-full px-3 py-1.5 bg-white text-slate-600 border border-slate-200 rounded-lg text-xs font-medium hover:bg-slate-50 hover:shadow-md transition-all duration-200"
        >
          重置数据
        </button>
      </div>
    </div>
  );
}
