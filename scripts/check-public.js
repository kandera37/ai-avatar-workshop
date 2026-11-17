const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules', '.git', '.runtime', 'artifacts', 'data']);
const forbidden = [
  /https?:\/\/[a-z0-9.-]+\.(?:internal|local)(?:[/:]|$)/i,
  /[A-Z]:[\\/](?:Users|Desktop)[\\/]/i,
  /(?:qx_|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}/,
];
const binary = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.woff2', '.zip']);
let files = 0;
const failures = [];
function visit(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const absolute = path.join(directory, item.name);
    const relative = path.relative(root, absolute);
    if (item.isSymbolicLink()) { failures.push(relative + ' is a symlink'); continue; }
    if (item.isDirectory()) { visit(absolute); continue; }
    files++;
    if (/\.(db|sqlite3?|log)$/.test(item.name) || item.name === '.env' || /cookie|session\.json/i.test(item.name)) {
      failures.push(relative + ' is a runtime file');
    }
    if (binary.has(path.extname(item.name))) continue;
    // The scanner itself names excluded identifiers to prevent regression.
    if (relative === path.join('scripts', 'check-public.js')) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    if (forbidden.some(pattern => pattern.test(text))) failures.push(relative + ' contains an excluded identifier');
  }
}
visit(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public file gate passed for ' + files + ' files.');
}
