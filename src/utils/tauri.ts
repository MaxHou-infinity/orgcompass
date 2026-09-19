/**
 * Tauri 桌面环境适配工具
 * 
 * 同一份前端代码同时支持：
 * - 浏览器（Web）：导出走 a.click() 下载
 * - Tauri 桌面：导出走原生"另存为"对话框 + fs 写入
 */

/** 检测当前是否运行在 Tauri 桌面环境 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 导出文件：优先用 Tauri 原生保存对话框，浏览器环境回退到下载。
 *
 * v2.3.1（Q-12）语义修正：**「用户取消」与「写入失败」必须区分**。
 * 旧实现在 Tauri 写入失败时静默回退成浏览器下载并返回 true → 调用方 toast「已导出」，
 * 而文件其实落在了 WebView 的下载目录（桌面端用户根本不知道去哪找），
 * 甚至 `.orgproj` 备份会出现「提示已导出但目标路径没有文件」。
 * 现在：取消 → false；写入失败 → 抛错（由调用方的 catch 给出可见失败提示），不再静默改道。
 *
 * @returns 是否真的写出了文件（false = 用户主动取消）
 * @throws 原生写入失败（不静默回退）
 */
export async function saveFile(
  defaultName: string,
  data: ArrayBuffer | Uint8Array,
  mimeType: string,
): Promise<boolean> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: defaultName });
    if (!path) return false; // 用户取消 → 明确告知调用方，不改道下载
    await writeFile(path, bytes); // 失败向上抛，由调用方给出可见错误
    return true;
  }

  // 浏览器下载（仅非 Tauri 环境）
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = defaultName;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

/** 保存文本文件（.orgproj JSON / 报告 HTML 等）：Tauri 原生另存为，浏览器回退下载。 */
export async function saveTextFile(
  defaultName: string,
  text: string,
  mimeType = 'application/json',
): Promise<boolean> {
  return saveFile(defaultName, new TextEncoder().encode(text), mimeType);
}
