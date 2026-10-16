// 在 jsdom 加载之前失败，避免只看到 Node 环境用例通过而误读为全量通过。
const [major, minor, patch] = process.versions.node.split('.').map(Number);
const supported = major >= 26 || (major === 24 && minor >= 15) ||
  (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)));
if (!supported) {
  console.error(`当前 Node ${process.versions.node} 不支持本项目的完整测试环境（jsdom 30）。请使用 ^22.22.2、^24.15.0 或 >=26.0.0；可先执行 nvm use，再运行 npm ci 和 npm run verify。`);
  process.exit(1);
}
