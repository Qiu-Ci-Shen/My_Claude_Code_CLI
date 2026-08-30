// 一次性清理 i18n 死键：已删除功能的残留翻译（官方插件区/入门模板/全部推荐卡）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales');
const deadKeys = [
  'sections.officialTitle',
  'sections.officialDescription',
  'starterPluginLabel',
  'starter',
  'docs',
  'starterPlugin',
  'terminalPlugin',
  'scheduledPromptPlugin',
  'claudeWatchPlugin',
  'prism',
  'sessionManagerPlugin',
  'tokenCostCalculatorPlugin',
  'taskQueuePlugin',
  'githubIssuesBoardPlugin',
  'claudeUsagePlugin',
  'codexUsagePlugin',
];

let totalRemoved = 0;
const locales = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());
for (const locale of locales) {
  const file = path.join(root, locale, 'settings.json');
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const pluginSettings = json.pluginSettings;
  if (!pluginSettings) continue;

  let removed = 0;
  for (const key of deadKeys) {
    const [head, tail] = key.split('.');
    if (tail) {
      const section = pluginSettings[head];
      if (section && typeof section === 'object' && tail in section) {
        delete section[tail];
        removed++;
        if (Object.keys(section).length === 0) delete pluginSettings[head];
      }
    } else if (head in pluginSettings) {
      delete pluginSettings[head];
      removed++;
    }
  }

  if (removed > 0) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`${locale}/settings.json: 移除 ${removed} 个死键`);
    totalRemoved += removed;
  }
}
console.log(`合计移除 ${totalRemoved} 个死键（${locales.length} 个语言目录）`);
