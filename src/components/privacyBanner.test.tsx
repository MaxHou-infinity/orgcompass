// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../App';
import { OnboardingOverlay } from './OnboardingOverlay';
import { PrivacyBanner } from './PrivacyBanner';
import { createProject, PROJECT_STORAGE_KEY } from '../utils/project';

/**
 * 公开 Web 演示的隐私条与「先用虚构示例」主按钮。
 * 不复用 org-designer.onboarded：看过三步引导的人仍要看到这条说明。
 */

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  storage.set('org-designer.display-hint', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PrivacyBanner', () => {
  it('Web 首屏说明数据留在浏览器，并提供虚构示例入口', () => {
    const onOpenSamples = vi.fn();
    render(<PrivacyBanner onOpenSamples={onOpenSamples} />);
    expect(screen.getByRole('region', { name: '隐私与演示数据说明' }).textContent).toMatch(/localStorage/);
    expect(screen.getByRole('region', { name: '隐私与演示数据说明' }).textContent).toMatch(/不会上传/);
    fireEvent.click(screen.getByRole('button', { name: '打开虚构示例' }));
    expect(onOpenSamples).toHaveBeenCalledOnce();
  });

  it('关闭后写入独立标记，再次进入不再占首屏', () => {
    const { unmount } = render(<PrivacyBanner onOpenSamples={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭隐私说明' }));
    expect(storage.get('org-designer.privacy-ack')).toBe('1');
    unmount();
    render(<PrivacyBanner onOpenSamples={vi.fn()} />);
    expect(screen.queryByRole('region', { name: '隐私与演示数据说明' })).toBeNull();
  });

  it('Tauri 只显示一行本地说明，不重复 Web 演示文案', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    render(<PrivacyBanner onOpenSamples={vi.fn()} />);
    expect(screen.getByRole('note', { name: '本地数据说明' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开虚构示例' })).toBeNull();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

describe('首次引导把虚构示例放在主路径', () => {
  it('主按钮是载入虚构示例，并写明不要粘贴真实名册', () => {
    const onLoadTemplate = vi.fn();
    const onClose = vi.fn();
    render(
      <OnboardingOverlay open onClose={onClose} onDownloadTemplate={vi.fn()} onLoadTemplate={onLoadTemplate} />,
    );
    expect(screen.getByRole('dialog', { name: '首次使用引导' }).textContent).toMatch(/不要粘贴真实员工名册/);
    fireEvent.click(screen.getByRole('button', { name: '载入虚构示例' }));
    expect(onLoadTemplate).toHaveBeenCalledWith('internet');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('空工作区首屏', () => {
  it('隐私条与空状态同时在，主按钮仍是载入示例数据', () => {
    storage.set('org-designer.onboarded', '1');
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(createProject('空')));
    render(<App />);
    expect(screen.getByRole('region', { name: '隐私与演示数据说明' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '先用虚构示例看一遍' })).toBeTruthy();
    const sampleButtons = screen.getAllByRole('button', { name: '载入示例数据' });
    const download = screen.getByRole('button', { name: '下载空白模板' });
    // 侧栏在前、空状态在后；空状态里示例按钮必须排在下载模板之前。
    expect(sampleButtons).toHaveLength(2);
    expect(sampleButtons[1].compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
