import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectFolder, ProjectStore, discoverProjectFolders, folderProject, isDirectory, mergeProjects, normalizeFolder, searchProjects } from './projects';

interface ProjectItem extends vscode.QuickPickItem {
  project?: ProjectFolder;
  browse?: boolean;
}

export async function pickProject(projects: ProjectStore, seeds: ProjectFolder[], roots: string[], current?: string): Promise<ProjectFolder | undefined> {
  const picker = vscode.window.createQuickPick<ProjectItem>();
  picker.title = 'Choose Project Folder';
  picker.placeholder = 'Search project names or folders — recent projects appear first';
  picker.matchOnDescription = false; // "Recent project" is a status, not a search term
  picker.matchOnDetail = true;
  const renameButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Name this project' };
  const discovered: ProjectFolder[] = [];
  let closed = false;
  let accepting = false;
  let editing = false;
  let browsing = false;
  const disposables: vscode.Disposable[] = [];
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const render = (): void => {
    if (closed) return;
    const activeCwd = picker.activeItems[0]?.project?.cwd;
    const recent = projects.recent();
    const saved = new Set(recent.map((p) => p.cwd));
    const items: ProjectItem[] = searchProjects(mergeProjects(recent, seeds, discovered), picker.value).map((project) => ({
      label: project.name,
      description: project.cwd === current ? 'Current project' : saved.has(project.cwd) ? 'Recent project' : 'Workspace folder',
      detail: project.cwd,
      project,
      buttons: [renameButton],
    }));
    const typed = normalizeFolder(picker.value.trim());
    if (picker.value.trim() && path.isAbsolute(typed) && !items.some((i) => i.project?.cwd === typed)) {
      items.unshift({ label: 'Use this folder', detail: typed, alwaysShow: true, project: folderProject(typed) });
    }
    items.push({ label: '$(folder-opened) Browse for a folder…', alwaysShow: true, browse: true });
    picker.items = items;
    const active = items.find((i) => i.project?.cwd === (activeCwd ?? current));
    if (active) picker.activeItems = [active];
  };

  return new Promise<ProjectFolder | undefined>((resolve) => {
    const finish = (project?: ProjectFolder): void => {
      if (closed) return;
      closed = true;
      if (renderTimer) clearTimeout(renderTimer);
      for (const d of disposables) d.dispose();
      picker.dispose();
      resolve(project);
    };
    disposables.push(picker.onDidHide(() => { if (!editing && !browsing) finish(); }));
    disposables.push(picker.onDidChangeValue(render));
    disposables.push(picker.onDidTriggerItemButton(async ({ item }) => {
      if (!item.project || editing || accepting) return;
      editing = true;
      const project = item.project;
      try {
        const name = await vscode.window.showInputBox({ title: 'Name Project', prompt: project.cwd, value: project.name,
          validateInput: (v) => v.trim() ? undefined : 'Enter a project name' });
        if (name?.trim()) projects.remember({ ...project, name: name.trim() });
      } catch (error) { void vscode.window.showErrorMessage(`Could not save project name: ${String(error)}`); }
      finally { editing = false; render(); if (!closed) picker.show(); }
    }));
    disposables.push(picker.onDidAccept(async () => {
      if (accepting || editing || closed) return;
      const item = picker.selectedItems[0];
      if (!item) return;
      accepting = true;
      try {
        let project = item.project;
        if (item.browse) {
          browsing = true;
          const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, openLabel: 'Choose Project Folder',
            defaultUri: current ? vscode.Uri.file(current) : undefined });
          if (folders?.[0]) {
            const cwd = folders[0].fsPath;
            project = projects.recent().find((p) => p.cwd === cwd) ?? folderProject(cwd);
          }
        }
        if (closed) return;
        if (!project) { picker.show(); return; }
        if (!await isDirectory(project.cwd)) {
          await vscode.window.showWarningMessage(`Folder is unavailable: ${project.cwd}. Choose another folder or reconnect the drive.`);
          if (!closed) picker.show();
          return;
        }
        finish(project);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not choose project: ${String(error)}`);
        if (!closed) picker.show();
      } finally { accepting = false; browsing = false; }
    }));
    render();
    picker.busy = roots.length > 0;
    picker.show();
    void discoverProjectFolders(roots, { canceled: () => closed, onBatch: (batch) => {
      discovered.push(...batch);
      if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; render(); }, 80);
    } }).then(({ truncated }) => {
      if (closed) return;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = undefined; }
      render();
      picker.busy = false;
      if (truncated) picker.placeholder = 'Search projects — discovery limit reached; Browse can select any folder';
    }).catch(() => { if (!closed) picker.busy = false; });
  });
}
