const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAgentWorking } = require('../out/working-status');

test('Codex busy title follows start, work, approval, completion, and process exit without a hold', () => {
  for (const frame of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') {
    assert.equal(isAgentWorking('codex', `${frame} Repair PTT | host`), true);
  }
  assert.equal(isAgentWorking('codex', '[ ! ] Action Required | Repair PTT | host'), false);
  assert.equal(isAgentWorking('codex', 'Repair PTT | host'), false);
  assert.equal(isAgentWorking('zsh', '⠋ Repair PTT | host'), false, 'stale OSC title after exit');
  assert.equal(isAgentWorking('codex', ''), false, 'missing signal cannot retain blue');
});

test('idle screen animation, old interrupt phrases, and unrelated agents never establish work', () => {
  // These actual idle titles remain unchanged while the prompt particle animation redraws.
  for (const title of ['Prepare Ads and SEO proposals | maxtymosh', 'Recover gopetzen.com | maxtymosh', 'esc to interrupt | host']) {
    assert.equal(isAgentWorking('codex', title), false);
  }
  for (const command of ['zsh', 'claude', '2.1.284', 'grok', 'agy']) {
    assert.equal(isAgentWorking(command, '⠋ Repair PTT | host'), false);
  }
  assert.equal(isAgentWorking('codex', 'Repair ⠋ PTT | host'), false);
  assert.equal(isAgentWorking('codex', '⠁ particle | host'), false);
});
