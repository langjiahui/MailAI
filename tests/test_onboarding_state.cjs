const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/web/static/onboarding.js'), 'utf8');

assert.match(source, /button\.onclick = \(\) => action\(button\)/,
  'guide actions should receive their button so they can expose a busy state');
assert.match(source, /if \(aiRunning \|\| el\('assistant-send'\)\?\.disabled\)/,
  'the assistant guide must reject repeated submissions while a request is active');
assert.match(source, /button\.disabled = true; button\.textContent = '正在总结…'/,
  'the guide action must lock immediately and explain its state');
assert.match(source, /async function hasAssistantHistory\(\)[\s\S]*message_count\) >= 2/,
  'persisted assistant history should identify returning users after reinstall');
assert.match(source, /!state\.aiDone && ready\(\) && await hasAssistantHistory\(\)/,
  'connected users with prior assistant use should not receive first-use prompting');
assert.match(source, /const guided = aiRunning; state\.aiDone = true/,
  'any successful assistant response should complete the assistant tutorial');

console.log('PASS onboarding request lock and returning-user assistant detection');
