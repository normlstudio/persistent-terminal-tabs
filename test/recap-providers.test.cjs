const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateWithFallback, parseProviderOutput } = require('../out/recap-providers');

const value = { title: 'PTT naming', recap: 'Restore name generation with CLI fallback.' };
const claude = JSON.stringify({ is_error: false, result: JSON.stringify(value) });
const codex = [
  { type: 'item.completed', item: { type: 'error', message: 'Non-fatal catalog warning' } },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed' },
].map(JSON.stringify).join('\n');

function fixtures(t, responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-provider-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, 'trace.jsonl');
  const commands = {};
  for (const provider of ['claude', 'codex', 'grok']) {
    const file = path.join(dir, provider);
    commands[provider] = file;
    const response = responses[provider];
    if (!response) continue; // Deliberately missing CLI.
    fs.writeFileSync(file, `#!${process.execPath}\n
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({provider:${JSON.stringify(provider)},args:process.argv.slice(2),cwd:process.cwd(),mode:fs.statSync('prompt.txt').mode & 0o777})+'\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        setTimeout(() => { process.stdout.write(${JSON.stringify(response.stdout ?? '')}); process.stderr.write(${JSON.stringify(response.stderr ?? '')}); process.exit(${response.exit ?? 0}); }, ${response.delay ?? 0});
      });`, { mode: 0o700 });
  }
  return { dir, commands, trace: () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('parses Claude, Codex JSONL and Grok structured envelopes', () => {
  assert.deepEqual(parseProviderOutput('claude', claude), value);
  assert.deepEqual(parseProviderOutput('codex', codex), value);
  assert.deepEqual(parseProviderOutput('grok', JSON.stringify(value)), value);
  assert.deepEqual(parseProviderOutput('grok', JSON.stringify({ text: JSON.stringify(value), stopReason: 'end_turn' })), value);
  assert.deepEqual(parseProviderOutput('grok', JSON.stringify({ result: '```json\n'+JSON.stringify(value)+'\n```' })), value);
});

test('rejects errors, partial Codex turns and invalid fields', () => {
  assert.equal(parseProviderOutput('claude', JSON.stringify({ is_error: true, result: JSON.stringify(value) })), null);
  assert.equal(parseProviderOutput('codex', codex.split('\n').slice(0, -1).join('\n')), null);
  assert.equal(parseProviderOutput('codex', codex+'\n'+JSON.stringify({ type: 'turn.failed' })), null);
  for (const data of [{ title: {}, recap: 'x' }, { title: ' ', recap: 'x' }, { title: 'x', recap: '' }]) {
    assert.equal(parseProviderOutput('grok', JSON.stringify(data)), null);
  }
});

test('keeps Claude first and stops without starting fallbacks on success', async (t) => {
  const f = fixtures(t, { claude: { stdout: claude }, codex: { stdout: codex } });
  const result = await generateWithFallback('synthetic source packet', { commands: f.commands });
  assert.deepEqual(result, { ...value, provider: 'claude' });
  assert.deepEqual(f.trace().map(x => x.provider), ['claude']);
  assert.equal(f.trace()[0].mode, 0o600);
  assert.equal(fs.existsSync(f.trace()[0].cwd), false, 'request files removed');
});

test('expired Claude login fails over to Codex with safe diagnostics and restricted invocation', async (t) => {
  const f = fixtures(t, { claude: { exit: 1, stdout: 'OAuth expired SECRET-SENTINEL' }, codex: { stdout: codex } });
  const diagnostics = [];
  const result = await generateWithFallback('synthetic source packet', { commands: f.commands, onDiagnostic: m => diagnostics.push(m) });
  assert.equal(result.provider, 'codex');
  assert.deepEqual(f.trace().map(x => x.provider), ['claude', 'codex']);
  assert.match(diagnostics[0], /login expired/);
  assert.equal(diagnostics.join('').includes('SECRET-SENTINEL'), false);
  const args = f.trace()[1].args;
  for (const expected of ['--ephemeral', '--ignore-user-config', 'read-only', 'shell_tool', 'plugins', 'hooks']) assert.ok(args.includes(expected));
});

test('missing Claude and failed Codex use Grok and clean up the prompt file', async (t) => {
  const f = fixtures(t, { codex: { exit: 1, stderr: 'quota exceeded' }, grok: { stdout: JSON.stringify({ result: JSON.stringify(value) }) } });
  const result = await generateWithFallback('synthetic source packet', { commands: f.commands });
  assert.equal(result.provider, 'grok');
  const trace = f.trace();
  assert.deepEqual(trace.map(x => x.provider), ['codex', 'grok']);
  assert.ok(trace[1].args.includes('--prompt-file'));
  assert.ok(trace[1].args.includes('--deny'));
  assert.ok(trace[1].args.includes('--no-subagents'));
  assert.equal(fs.existsSync(trace[1].cwd), false);
});

test('malformed output and exhausted providers return null without saving error text', async (t) => {
  const f = fixtures(t, { claude: { stdout: '{invalid' }, codex: { stdout: '{"type":"turn.failed"}' }, grok: { exit: 1 } });
  assert.equal(await generateWithFallback('synthetic', { commands: f.commands }), null);
  assert.deepEqual(f.trace().map(x => x.provider), ['claude', 'codex', 'grok']);
  assert.equal(fs.existsSync(f.trace()[0].cwd), false);
});

test('a stalled provider is killed and the next provider completes', async (t) => {
  const f = fixtures(t, { claude: { delay: 5000, stdout: claude }, codex: { stdout: codex } });
  const diagnostics = [];
  const result = await generateWithFallback('synthetic', { commands: f.commands, timeoutMs: 600, onDiagnostic: m => diagnostics.push(m) });
  assert.equal(result.provider, 'codex');
  assert.match(diagnostics[0], /timed out/);
});

test('Codex can recap a Claude transcript without changing its source or session identity', async (t) => {
  const f = fixtures(t, { claude: { exit: 1, stderr: 'OAuth session expired' }, codex: { stdout: codex } });
  const id = '11111111-1111-4111-8111-111111111111';
  const project = path.join(f.dir, '.claude', 'projects', 'test-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, id+'.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Restore PTT naming after login expiry.' } })+'\n');
  const original = os.homedir;
  let generateRecap;
  try {
    os.homedir = () => f.dir;
    ({ generateRecap } = require('../out/recaps'));
  } finally { os.homedir = original; }
  const result = await generateRecap(id, { commands: f.commands });
  assert.equal(result.provider, 'codex');
  assert.equal(result.source, 'claude');
  assert.equal(result.codexSessionId, undefined);
});
