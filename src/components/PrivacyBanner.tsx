import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { isTauri } from '../utils/tauri';

/**
 * 首屏隐私说明。
 *
 * 公开 Web 演示没有账号、也没有业务服务器：项目自动写在浏览器 localStorage。
 * 横幅必须在空画布和已有数据两种情况下都出现，否则回访用户看不到「不要贴真实名册」。
 * 桌面版（Tauri）数据同样不上传，但保存对话框已经是本地文件流，所以只留一行，避免盖住工作台。
 *
 * 关闭状态单独记在 `org-designer.privacy-ack`，不复用 `org-designer.onboarded`：
 * 老用户已经看过三步引导，仍需要第一次看到这条隐私说明。
 */
const PRIVACY_ACK_KEY = 'org-designer.privacy-ack';

interface PrivacyBannerProps {
  /** 打开内置行业模板选择器。这些模板是合成组织，用来替代「先导入真实 Excel」。 */
  onOpenSamples: () => void;
}

export function PrivacyBanner({ onOpenSamples }: PrivacyBannerProps) {
  // 先隐藏，读完 localStorage 再决定。避免已确认的用户每次刷新都闪一条全宽警告。
  const [visible, setVisible] = useState(false);
  const desktop = isTauri();

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        setVisible(true);
        return;
      }
      setVisible(localStorage.getItem(PRIVACY_ACK_KEY) !== '1');
    } catch {
      // 部分隐私模式会让 localStorage 抛错。宁可再显示一次，也不要当成用户已经知情。
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(PRIVACY_ACK_KEY, '1');
    } catch {
      /* 写不进存储时仍允许先收起，下一次打开会再提示 */
    }
    setVisible(false);
  };

  if (desktop) {
    return (
      <div
        role="note"
        aria-label="本地数据说明"
        className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span>桌面版数据留在本机，不会上传。共用电脑时请勿留下无关人员的敏感信息。</span>
        <button type="button" onClick={dismiss} className="underline underline-offset-2" aria-label="关闭本地数据说明">
          知道了
        </button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="隐私与演示数据说明"
      className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-950"
    >
      <div className="flex flex-wrap items-start gap-3">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-[16rem] flex-1 text-sm leading-relaxed">
          <strong className="font-semibold">数据只留在这台浏览器。</strong>
          {' '}自动保存在 localStorage，不会上传到 OrgCompass 的服务器，也没有账号登录。
          请不要粘贴真实员工名册或个人敏感信息，先用内置虚构示例。
          企业若自行导入真实数据，风险由企业自行承担；公用电脑请在结束后清理本站点数据。
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenSamples}
            className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-950"
          >
            打开虚构示例
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100"
            aria-label="关闭隐私说明"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
