const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../out/codex-history');
const thread = { id: 'modern-chat', name: 'PTT status repair', cwd: '/project', updatedAt: 42, historyMode: 'paginated' };

test('full footer or terminal title identifies one chat; duplicates and truncation never guess', () => {
  assert.equal(h.matchCodexScreen('GPT-6-Astra high · ~ · PTT status repair', [thread]), thread);
  assert.equal(h.matchCodexScreen('GPT-6-Astra high · ~ · PTT…', [thread]), undefined);
  assert.equal(h.matchCodexScreen('', [thread], 'PTT status repair | host'), thread);
  assert.equal(h.matchCodexScreen('', [thread, {...thread, id:'other'}], 'PTT status repair | host'), undefined);
  assert.equal(h.matchCodexScreen('PTT status repair', [thread]), undefined);
});

test('paginated Codex history uses only read APIs, keeps exact identity, and includes latest messages', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-history-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const cli = path.join(dir, 'codex'); const trace = path.join(dir, 'calls');
  fs.writeFileSync(cli, `#!${process.execPath}\n
    const fs=require('fs'), rl=require('readline').createInterface({input:process.stdin});
    const item=(id,type,text)=>({item:{id,type,text,content:[{type:'text',text}]}});
    rl.on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(trace)},q.method+'\\n');
      if(!q.id)return;
      let result={};
      if(q.method==='thread/list')result={data:[${JSON.stringify(thread)}],nextCursor:null};
      if(q.method==='thread/read')result={thread:${JSON.stringify(thread)}};
      if(q.method==='thread/items/list')result=q.params.sortDirection==='asc'
        ?{data:[item('first','userMessage','Please repair PTT')],nextCursor:'more'}
        :{data:[item('last','agentMessage','Repair verified'),item('tool','commandExecution','DO NOT SUMMARIZE'),item('first','userMessage','Please repair PTT')],nextCursor:null};
      process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
    });`, {mode:0o700});
  h.configureCodexHistory(cli);
  await h.refreshCodexThreads(true);
  assert.equal(h.cachedCodexThread('modern-chat').historyMode, 'paginated');
  const r = await h.codexConversation('modern-chat');
  assert.deepEqual(r.messages,[{role:'user',text:'Please repair PTT'},{role:'assistant',text:'Repair verified'}]);
  const reader = new h.CodexReader(cli);
  await assert.rejects(reader.request('thread/resume', {}), /Read-only/);
  reader.close();
  assert.ok(fs.readFileSync(trace,'utf8').split('\n').every(x=>['','initialize','initialized','thread/list','thread/read','thread/items/list'].includes(x)));
});

test('missing history CLI rejects promptly and does not leave requests hanging', async () => {
  const reader = new h.CodexReader('/missing/ptt-codex-cli');
  try { await assert.rejects(reader.initialize(), /closed/); }
  finally { reader.close(); }
});
