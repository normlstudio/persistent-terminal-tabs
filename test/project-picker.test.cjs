const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore, folderProject } = require('../out/projects');
let picker;
let browseResult;
let alias;
let warnings = [];
function emitter() {
  const listeners = [];
  return { on(fn) { listeners.push(fn); return { dispose() { const i=listeners.indexOf(fn); if(i>=0) listeners.splice(i,1); } }; },
    async fire(arg) { for (const fn of [...listeners]) await fn(arg); } };
}
class Picker {
  constructor() {
    this.items=[]; this.activeItems=[]; this.selectedItems=[]; this.value='';
    this.hide=emitter(); this.change=emitter(); this.accept=emitter(); this.button=emitter();
    this.onDidHide=this.hide.on; this.onDidChangeValue=this.change.on;
    this.onDidAccept=this.accept.on; this.onDidTriggerItemButton=this.button.on;
  }
  show() { this.visible=true; }
  dispose() { this.disposed=true; }
  async choose(item) { this.selectedItems=[item]; await this.accept.fire(); }
}
const original = Module._load;
Module._load = function(name, ...args) {
  if(name==='vscode') return { ThemeIcon: class {}, Uri:{file:(fsPath)=>({fsPath})}, window:{
    createQuickPick:()=>picker=new Picker(),
    showInputBox:async()=>{ await picker.hide.fire(); return alias; },
    showOpenDialog:async()=>{ await picker.hide.fire(); return browseResult; },
    showWarningMessage:async(m)=>warnings.push(m), showErrorMessage:async(m)=>{ throw Error(m); }
  }};
  return original.call(this,name,...args);
};
const { pickProject } = require('../out/project-picker');
Module._load=original;

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptt-picker-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  warnings=[]; browseResult=undefined; alias=undefined;
  return {dir, projects:new ProjectStore(path.join(dir,'projects.json'))};
}

test('picker displays full paths, searches aliases/details and cancel selects nothing', async(t)=>{
  const {dir,projects}=fixture(t);
  projects.remember({name:'Reels',cwd:dir});
  const result=pickProject(projects,[],[]);
  assert.equal(picker.items[0].label,'Reels');
  assert.equal(picker.items[0].detail,dir);
  assert.equal(picker.matchOnDetail,true);
  await picker.hide.fire();
  assert.equal(await result,undefined);
  assert.equal(picker.disposed,true);
});

test('rename and browse dialogs can hide the picker without canceling selection', async(t)=>{
  const {dir,projects}=fixture(t);
  const result=pickProject(projects,[folderProject(dir)],[]);
  alias='Reels';
  await picker.button.fire({item:picker.items[0]});
  assert.equal(picker.disposed,undefined);
  assert.equal(picker.items[0].label,'Reels');
  browseResult=[{fsPath:dir}];
  await picker.choose(picker.items.find((i)=>i.browse));
  assert.equal((await result).name,'Reels');
});

test('canceling Browse returns to picker; missing project remains repairable', async(t)=>{
  const {dir,projects}=fixture(t);
  const missing=path.join(dir,'removed');
  const result=pickProject(projects,[folderProject(missing),folderProject(dir)],[]);
  await picker.choose(picker.items.find((i)=>i.browse));
  assert.equal(picker.disposed,undefined);
  await picker.choose(picker.items.find((i)=>i.project?.cwd===missing));
  assert.equal(warnings.length,1);
  assert.equal(picker.disposed,undefined);
  await picker.choose(picker.items.find((i)=>i.project?.cwd===dir));
  assert.equal((await result).cwd,dir);
});

test('typed absolute path can be selected and batches preserve recent aliases', async(t)=>{
  const {dir,projects}=fixture(t);
  fs.mkdirSync(path.join(dir,'Reels'));
  projects.remember({name:'Video studio',cwd:path.join(dir,'Reels')});
  const result=pickProject(projects,[],[dir]);
  await new Promise((resolve)=>setTimeout(resolve,30));
  assert.equal(picker.items.filter((i)=>i.project?.cwd===path.join(dir,'Reels')).length,1);
  assert.equal(picker.items.find((i)=>i.project?.cwd===path.join(dir,'Reels')).label,'Video studio');
  picker.value=dir;
  await picker.change.fire(dir);
  await picker.choose(picker.items.find((i)=>i.project?.cwd===dir));
  assert.equal((await result).cwd,dir);
});
