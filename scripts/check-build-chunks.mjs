import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const root = resolve('dist');
const manifest = JSON.parse(readFileSync(resolve(root, '.vite/manifest.json'), 'utf8'));
const main = manifest['index.html'];
if (!main || statSync(resolve(root, main.file)).size >= 350 * 1024) throw new Error('主入口必须小于 350KB');
for (const view of ['HealthDrawer', 'CompetencyDrawer', 'ScenarioDiffView', 'DiagnosticReport', 'LevelManagerModal', 'PositionBoardPage']) {
  const entry = manifest[`src/components/${view}.tsx`];
  if (!entry?.isDynamicEntry) throw new Error(`${view} 必须是动态入口`);
}
for (const chunk of Object.values(manifest)) {
  for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    const localPath = relative(root, resolve(root, file));
    if (/^(https?:)?\/\//.test(file) || localPath === '..' || localPath.startsWith('..' + sep) || isAbsolute(localPath)) throw new Error(`资源必须位于本地 dist：${file}`);
    statSync(resolve(root, file));
  }
  for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
    if (!manifest[dependency]) throw new Error(`缺少离线依赖 ${dependency}`);
  }
}
console.log(`主入口 ${(statSync(resolve(root, main.file)).size / 1024).toFixed(1)}KB；六个视图均为动态入口，完整本地资源依赖已校验。`);
