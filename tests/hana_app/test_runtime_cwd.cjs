const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const appSource = fs.readFileSync(path.join(root, 'apps/hana-danus/index.js'), 'utf8');

test('all managed Danus entrypoints start in App dataDir while executable and service stay under appDir', () => {
  const startCall = appSource.match(/return sdk\.runtime\.start\(\{([\s\S]*?)\n\s*\}\);/);
  assert.ok(startCall, 'managed runtime start options are present');
  const options = startCall[1];

  assert.match(options, /command:\s*path\.join\(appDir, "dependencies", "python", "bin", "python3"\)/);
  assert.match(options, /path\.join\(appDir, "service", script\)/);
  assert.match(options, /cwd:\s*sdk\.dataDir/);
  assert.match(options, /"--data-dir", sdk\.dataDir/);
  assert.doesNotMatch(options, /cwd:\s*appDir/);
});
