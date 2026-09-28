const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'vscode') return {
    EventEmitter: class {event=()=>{}; fire(){}},
    TreeItem: class {constructor(label){this.label=label;}},
    ThemeIcon: class {constructor(id,color){this.id=id;this.color=color;}},
    ThemeColor: class {constructor(id){this.id=id;}},
    MarkdownString: class {appendMarkdown(){}},
    TreeItemCollapsibleState:{None:0}
  };
  return original.call(this,name,...args);
};
const {TabsTree} = require('../out/tree');
Module._load=original;

test('status dot renders blue working, green attached, yellow detached, grey suspended', () => {
  let open=false, alive=false, working=false;
  const tree=new TabsTree({meta:()=>({title:'test'}),groups:[]},()=>open,()=>{},()=>alive,()=>working);
  const item=()=>tree.getTreeItem({kind:'tab',id:'test',group:'group'}).iconPath;
  assert.equal(item().id,'circle-outline');
  working=true;
  assert.equal(item().color,undefined,'no process must never show blue');
  alive=true;
  assert.equal(item().color.id,'charts.blue');
  working=false;
  assert.equal(item().color.id,'charts.yellow');
  open=true;
  assert.equal(item().color.id,'charts.green');
  working=true;
  assert.equal(item().color.id,'charts.blue');
});
