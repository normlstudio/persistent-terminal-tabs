const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('registered commands create named groups and launch all agents in their explicit folder', async(t)=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ptt-group-launch-'));
  const originalHome=os.homedir;
  os.homedir=()=>temp;
  t.after(()=>{ os.homedir=originalHome; fs.rmSync(temp,{recursive:true,force:true}); });
  const project=path.join(temp,'Reels'), other=path.join(temp,'Other');
  fs.mkdirSync(project); fs.mkdirSync(other);
  const handlers=new Map(), terminals=[], warnings=[];
  let selection=[];
  let choice;
  let asks=0;
  const disposable={dispose(){}};
  const mock={
    extensions:{getExtension:()=>undefined},
    EventEmitter:class {event=()=>disposable;fire(){}},
    StatusBarAlignment:{Right:1},
    Uri:{file:(fsPath)=>({fsPath,scheme:'file'}),parse:(s)=>({toString:()=>s})},
    workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:temp}}],getConfiguration:()=>({get:(key,fallback)=>key==='useTmux'?false:fallback})},
    commands:{registerCommand:(id,fn)=>{handlers.set(id,fn);return disposable;},executeCommand:async()=>undefined},
    window:{terminals,
      createOutputChannel:()=>({appendLine(){},show(){},dispose(){}}),
      createStatusBarItem:()=>({show(){},dispose(){}}),
      createTreeView:()=>({get selection(){return selection;},onDidChangeSelection:()=>disposable,
        reveal:async(node)=>{selection=[node];},dispose(){}}),
      registerFileDecorationProvider:()=>disposable,onDidOpenTerminal:()=>disposable,onDidCloseTerminal:()=>disposable,
      showWarningMessage:async(msg)=>{warnings.push(msg);return undefined;},
      createTerminal:(options)=>{
        const term={options,name:options.name,show(){mock.window.activeTerminal=term;},sendText(){},dispose(){}};
        terminals.push(term);return term;
      }
    }
  };
  const original=Module._load;
  Module._load=function(name,...args){
    if(name==='vscode') return mock;
    if(name==='./project-picker') return {pickProject:async()=>{asks++;return choice;}};
    if(name==='./codex-history') return {configureCodexHistory(){},refreshCodexThreads:async()=>{},cachedCodexThread:()=>undefined};
    return original.call(this,name,...args);
  };
  const extension=require('../out/extension');
  Module._load=original;
  t.after(()=>extension.deactivate());
  await extension.activate({subscriptions:[]});
  await handlers.get('terminalTabs.newGroup')();
  assert.equal(fs.existsSync(path.join(temp,'.terminal-tabs','workspaces')),false,'cancel creates no group/slice');
  choice={name:'Reels',cwd:project};
  await handlers.get('terminalTabs.newGroup')();
  const sliceFile=fs.readdirSync(path.join(temp,'.terminal-tabs/workspaces')).find((f)=>f.endsWith('.json'));
  const read=()=>JSON.parse(fs.readFileSync(path.join(temp,'.terminal-tabs/workspaces',sliceFile),'utf8'));
  assert.equal(read().groups[1].name,'Reels');
  assert.equal(read().groups[1].cwd,project);
  assert.equal(read().groups[1].sessionIds.length,0);
  for(const command of ['newChatInGroup','newCodexChat','newGrokChat','newAgyChat'])
    await handlers.get(`terminalTabs.${command}`)({kind:'group',name:'Reels'});
  assert.equal(asks,2,'plus never asks again for a valid bound group');
  assert.equal(terminals.length,4);
  assert.ok(terminals.every((t)=>t.options.cwd===project));
  assert.ok(terminals.slice(1).every((t,i)=>t.options.location.parentTerminal===terminals[i]));
  const originalIds=read().groups[1].sessionIds;
  choice={name:'Other',cwd:other};
  await handlers.get('terminalTabs.chooseGroupProject')({kind:'group',name:'Reels'});
  assert.ok(originalIds.every((id)=>read().sessions[id].cwd===project));
  await handlers.get('terminalTabs.newChatInGroup')({kind:'group',name:'Reels'});
  assert.equal(terminals[4].options.cwd,other);
  fs.rmdirSync(other);
  await handlers.get('terminalTabs.newChatInGroup')({kind:'group',name:'Reels'});
  assert.equal(terminals.length,5,'missing folder cannot silently create a HOME chat');
  assert.equal(warnings.length,1);
  assert.equal(read().groups[1].sessionIds.length,5);
  choice={name:'Reels',cwd:project};
  await handlers.get('terminalTabs.newGroup')();
  assert.equal(read().groups[1].name,'Reels (2)','same project can have separate groups');
  // Real tmux launch builder must carry this same cwd as an argument, including spaces and apostrophes.
  const {tmuxLaunch}=require('../out/tmux');
  const cwd=path.join(project,"a folder's name");
  const launch=tmuxLaunch('test-ptt-id',cwd,{command:'claude',resumeArgs:'--resume {id}',newArgs:''},false);
  if(launch) assert.equal(launch.shellArgs[launch.shellArgs.indexOf('-c')+1],cwd);
  extension.deactivate();
});
