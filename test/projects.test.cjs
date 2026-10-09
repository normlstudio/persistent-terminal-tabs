const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectStore, discoverProjectFolders, mergeProjects, folderProject, isDirectory, searchProjects } = require('../out/projects');
const { StateStore, NEW_GROUP } = require('../out/state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('named paths survive restart, deduplicate and preserve another window selection', (t) => {
  const dir = fixture(t), file = path.join(dir, 'projects.json');
  const a = new ProjectStore(file), b = new ProjectStore(file);
  a.remember({ name: 'Reels', cwd: path.join(dir, 'video') });
  b.remember({ name: 'Website', cwd: path.join(dir, 'web') });
  a.remember({ name: 'Video studio', cwd: path.join(dir, 'video', '.') });
  assert.equal(new ProjectStore(file).recent().length, 2);
  assert.equal(a.recent()[0].name, 'Video studio');
  assert.equal(a.recent()[1].name, 'Website');
  const merged = mergeProjects(a.recent(), [folderProject(path.join(dir, 'video'))]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'Video studio');
  fs.writeFileSync(file, '{bad');
  assert.deepEqual(a.recent(), []);
});

test('folder discovery finds nested projects, skips generated/hidden folders and symlink loops', async (t) => {
  const dir = fixture(t);
  for (const p of ['Media/Reels', 'node_modules/package', '.git/objects', 'dist/files', 'Web/site'])
    fs.mkdirSync(path.join(dir, p), { recursive: true });
  fs.symlinkSync(dir, path.join(dir, 'loop'), 'dir');
  const found = [];
  const result = await discoverProjectFolders([dir, dir], { onBatch: (batch) => found.push(...batch) });
  assert.equal(result.truncated, false);
  assert.deepEqual(found.map((p) => path.relative(dir, p.cwd)).sort(), ['Media', 'Media/Reels', 'Web', 'Web/site']);
  assert.ok(found.some((p) => p.name.toLowerCase().startsWith('re')));
  assert.equal(await isDirectory(path.join(dir, 'Media/Reels')), true);
  assert.equal(await isDirectory(path.join(dir, 'missing')), false);
  assert.equal(await isDirectory(__filename), false);
});

test('folder discovery obeys count, depth and cancellation limits', async (t) => {
  const dir = fixture(t);
  for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(dir, `p${i}`, 'nested'), { recursive: true });
  let found = [];
  assert.equal((await discoverProjectFolders([dir], { maxDirectories: 3, onBatch: (b) => found.push(...b) })).truncated, true);
  assert.ok(found.length <= 2);
  found = [];
  assert.equal((await discoverProjectFolders([dir], { maxDepth: 1, onBatch: (b) => found.push(...b) })).truncated, true);
  assert.ok(found.every((p) => path.dirname(p.cwd) === dir));
  found = [];
  await discoverProjectFolders([dir], { canceled: () => true, onBatch: (b) => found.push(...b) });
  assert.equal(found.length, 0);
});

test('each root gets its own discovery budget and short queries rank Reels above unrelated full paths', async (t) => {
  const dir = fixture(t), huge = path.join(dir, 'huge'), docs = path.join(dir, 'docs');
  for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(huge, `p${i}`), { recursive: true });
  fs.mkdirSync(path.join(docs, 'Channels/Reels'), { recursive: true });
  const found = [];
  await discoverProjectFolders([huge, docs], { maxDirectories: 3, onBatch: (b) => found.push(...b) });
  assert.ok(found.some((p) => p.name === 'Reels'), 'large first root cannot starve the second');
  const results = searchProjects([{ name: 'Website', cwd: '/Work Root/Projects/site' }, ...found], 're');
  assert.equal(results[0].name, 'Reels');
  assert.equal(searchProjects(found, 'no-such-folder').length, 0);
  assert.equal(searchProjects(found, '', 1).length, 1);
  const crowded = [...Array.from({ length: 300 }, (_, i) => ({ name: `references-${i}`, cwd: `/repo/${i}` })),
    { name: 'Reels', cwd: '/docs/Channels/Reels' }];
  assert.equal(searchProjects(crowded, 're')[0].name, 'Reels', 'deep short name is visible among many shallow prefix matches');
});

test('explicit group folder survives empty-group serialization and preserves old session cwd on move/change', (t) => {
  const dir = fixture(t);
  const store = new StateStore(path.join(dir, 'slice.json'), 'test');
  const g = store.addGroupAfterInbox('Reels', false);
  g.cwd = path.join(dir, 'Media/Reels');
  g.projectName = 'Reels';
  assert.equal(store.groupCwd('Reels'), g.cwd);
  // Serialize exactly the data a saved workspace slice holds, without touching real ~/.terminal-tabs.
  const data = JSON.parse(JSON.stringify({ groups: store.groups, sessions: {} }));
  const reopened = new StateStore(path.join(dir, 'slice.json'), 'test', data);
  assert.equal(reopened.groupCwd('Reels'), g.cwd);
  const meta = { title: 'existing', project: 'old', cwd: path.join(dir, 'old') };
  reopened.add('old', meta, NEW_GROUP);
  reopened.moveBefore(['old'], 'Reels');
  assert.equal(reopened.groupCwd('Reels'), g.cwd);
  assert.equal(reopened.meta('old').cwd, meta.cwd);
  reopened.groups.find((g) => g.name === 'Reels').cwd = path.join(dir, 'new');
  reopened.renameGroup('Reels', 'Video');
  assert.equal(reopened.groupCwd('Video'), path.join(dir, 'new'));
  assert.equal(reopened.meta('old').cwd, meta.cwd);
});

test('legacy groups retain majority/newest-tie cwd inference; inbox starts unbound', (t) => {
  const dir = fixture(t);
  const store = new StateStore(path.join(dir, 'slice.json'), 'test');
  store.add('a', { cwd: '/a' }, 'Legacy');
  store.add('b', { cwd: '/b' }, 'Legacy');
  assert.equal(store.groupCwd('Legacy'), '/b');
  store.add('c', { cwd: '/a' }, 'Legacy');
  assert.equal(store.groupCwd('Legacy'), '/a');
  store.add('d', { cwd: '/a' }, NEW_GROUP);
  assert.equal(store.groupCwd(NEW_GROUP), undefined);
});
