import { Plugin, Notice, Platform, requestUrl, apiVersion } from 'obsidian';
import type { TAbstractFile, TFile } from 'obsidian';
import { defaultSettings, validateSettings } from './settings.ts';
import type { Settings } from './settings.ts';
import { createNativeDav, DavError } from './transport.ts';
import type { NativeRequest } from './transport.ts';
import { openRepositoryV2 } from './repository.ts';
import { deriveLocalScope, targetKeyV2, classifyPath, bookmarksKey, normalizeRelativePath, isWithinPath } from './paths.ts';
import { openStateV2 } from './state.ts';
import { createVaultAccess, flushEditors, saveRecoveryEditors } from './vault.ts';
import { createBookmarkHost } from './bookmarks.ts';
import { createProjectionV2 } from './projection.ts';
import { createEngineV2 } from './engine.ts';
import { createLifecycleV2 } from './lifecycle.ts';
import type { LifecycleV2 } from './lifecycle.ts';
import { createDiagnostics } from './diagnostics.ts';
import { hashBytes } from './snapshots.ts';

import type { DirtyEvents, DirtyEvent } from './types.ts';
import type { RunOutcomeV2 as RunOutcome } from './v2-types.ts';
import { SyncSettingsTab, ConflictsModal, HistoryModal, CloseModal } from './ui.ts';
import { previewImportSource, readLegacyImport } from './migration.ts';
import type { MigrationPreview } from './migration.ts';
import { importIntoV2 } from './v2-migration.ts';
type Session = { state: Awaited<ReturnType<typeof openStateV2>>; repository: Awaited<ReturnType<typeof openRepositoryV2>>;
  dav: ReturnType<typeof createNativeDav>; projection: ReturnType<typeof createProjectionV2>; engine: ReturnType<typeof createEngineV2>;
  lifecycle: LifecycleV2; bookmarks: ReturnType<typeof createBookmarkHost>; generation: number; events: DirtyEvents; unsavedEvents: DirtyEvent[]; writes: Promise<void>; disposeEvents: (() => void)[];
  ownWrites: Map<string, string>; ownRenames: Map<string,string>; firstSync: boolean };
type SecretStore = { setSecret(id: string, value: string): void; getSecret(id: string): string | null };
export default class WebdavSync extends Plugin {
  settings: Settings = defaultSettings(); session?: Session; lastOutcome?: RunOutcome;
  readonly diagnostics = createDiagnostics(); statusText = 'Не подключено';
  private statusEl?: HTMLElement; private native: NativeRequest = requestUrl; private connecting = false;
  private guardAvailable = false; private release = false; private closeToken = 0; private closeDialog?: CloseModal;
  private get secrets() { return (this.app as unknown as { secretStorage?: SecretStore }).secretStorage; }
  async onload() {
    try { this.settings = validateSettings({ ...(await this.loadData() ?? {}), configDir: this.app.vault.configDir }); }
    catch { new Notice('WebDAV Sync: настройки повреждены. Проверьте их перед подключением.'); }
    if (this.settings.secretId && this.secrets) this.settings.password = this.secrets.getSecret(this.settings.secretId) ?? '';
    this.statusEl = this.addStatusBarItem(); this.renderStatus();
    this.addSettingTab(new SyncSettingsTab(this.app, this));
    this.addRibbonIcon('refresh-cw', 'WebDAV Sync', () => { void this.sync(); });
    for (const [id, name, run] of [
      ['sync', 'Синхронизировать сейчас', () => this.sync()],
      ['integrity', 'Проверить целостность читаемого дерева', () => this.sync(true)],
      ['conflicts', 'Конфликты и внешние изменения', () => { new ConflictsModal(this).open(); }],
      ['history', 'История версий и локальные копии', () => { new HistoryModal(this).open(); }],
      ['pack-history','Упаковать проверенную историю',async()=>{await this.connect();const session=this.session!;await session.lifecycle.exclusive(async()=>{await session.engine.maintenance(true);return session.engine.run();});}],
      ['diagnostics', 'Экспортировать безопасную диагностику', () => this.exportDiagnostics()],
    ] as const) this.addCommand({ id, name, callback: () => { void Promise.resolve(run()).catch(() => this.noticeFailure()); } });
    this.installCloseGuard();
    this.registerDomEvent(document, 'visibilitychange', () => this.session?.lifecycle.visibilityChanged(document.hidden));
    this.registerDomEvent(window, 'focus', () => { if (this.settings.autoSync && this.settings.syncOnFocus) void this.session?.lifecycle.requestSync('focus'); });
    this.registerEvent(this.app.workspace.on('quit', tasks => { if (this.session && !this.release) tasks.addPromise(this.session.lifecycle.close()); }));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync && this.settings.syncOnStartup && this.settings.endpoint && this.settings.root && this.settings.password) void this.connect().then(() => this.sync()).catch(() => this.noticeFailure());
    });
  }
  async saveConfiguration(value: Settings) {
    await this.stopSession(); this.settings = validateSettings({ ...value, configDir: this.app.vault.configDir });
    await this.persistSettings();
  }
  private async persistSettings() {
    const saved = structuredClone(this.settings);
    if (this.settings.rememberPassword && this.secrets && this.settings.endpoint && this.settings.root) {
      this.settings.secretId = saved.secretId = `webdav-sync-${(await targetKeyV2(this.settings)).slice(0, 40)}`;
      this.secrets.setSecret(saved.secretId, this.settings.password); saved.password = '';
    } else if (!this.settings.rememberPassword) saved.password = '';
    await this.saveData(saved);
  }
  async setLabNativeRequest(native: NativeRequest) {
    const marker = JSON.parse(await this.app.vault.adapter.read('.webdav-sync-lab.json'));
    if (marker.purpose !== 'webdav-sync-lab' || marker.schema !== 1) throw new Error('Not a marked lab vault.');
    this.native = native;
  }
  async connect() {
    if (this.session) return;
    if (this.connecting) throw new Error('Connection already in progress.');
    const config = validateSettings(this.settings);
    if (!config.endpoint || !config.root || !config.username || !config.password) throw new Error('Connection settings incomplete.');
    if (Platform.isDesktopApp && !this.guardAvailable) throw new Error('Desktop close guard unavailable on this host.');
    this.connecting = true; this.statusText = 'Проверка подключения'; this.renderStatus();
    const dav = createNativeDav(config, this.native);
    let state:Awaited<ReturnType<typeof openStateV2>>|undefined;
    try {
      const target = await targetKeyV2(config);
      const scope = await deriveLocalScope(this.app.vault, config.profileId);
      state = await openStateV2(scope,target,indexedDB);
      const repository = await openRepositoryV2(dav,state,{mode:config.repositoryMode,sessionId:state.sessionId,concurrency:config.concurrency});
      if(config.repositoryId && config.verifiedTarget===target && config.repositoryId!==repository.repositoryId)throw Error('Repository identity changed');
      this.settings.verifiedTarget=target;
      const bookmarks = config.bookmarks ? createBookmarkHost(this.app, state) : null;
      if (config.bookmarks && !bookmarks) { state.close(); throw new Error('Bookmark core bridge unavailable.'); }
      const projection = createProjectionV2(repository, dav, state,config);
      let session!: Session;
      const local = createVaultAccess(this.app.vault, config, state, bookmarks, {
        write: (path, hash) => session.ownWrites.set(path, hash), rename: (from, to) => session.ownRenames.set(from, to),
        flush: () => flushEditors(this.app.workspace),
        applied: async (source, target, backup) => {
          const leaves: import('obsidian').WorkspaceLeaf[] = [];
          this.app.workspace.iterateAllLeaves(leaf => { const file = (leaf.view as { file?: TFile }).file; if (file?.path === backup) leaves.push(leaf); });
          for (const leaf of leaves) {
            const file = target ? this.app.vault.getAbstractFileByPath(target) : null;
            if (file && 'stat' in file) await leaf.openFile(file as TFile); else leaf.detach();
          }
        },
      });
      const engine = createEngineV2({ repository, state, local, projection, deletionGuardPercent: config.deletionGuardPercent });
      const events = await state.getMeta<DirtyEvents>('dirty-events') ?? { generation: 0, renames: [] };
      session = { state, repository, dav, projection, engine, bookmarks, generation: events.generation, events, unsavedEvents: [], writes: Promise.resolve(), disposeEvents: [], lifecycle: undefined!, ownWrites: new Map(), ownRenames: new Map(), firstSync: true };
      const saveLocal = async () => { await flushEditors(this.app.workspace); await bookmarks?.flush(); };
      session.lifecycle = createLifecycleV2({ engine, flushEditors: saveLocal,
        flushForRecovery: async()=>{await saveRecoveryEditors(this.app.vault,this.app.workspace,bookmarks?.snapshot());await saveLocal().catch(()=>{});}, events: {
        generation: () => session.generation, flush: async () => { await session.writes.catch(() => {}); await this.flushEvents(session, session.generation); },
      }, debounceMs: config.debounceMs, pollMs: config.intervalSeconds * 1000, autoSync: config.autoSync,
        status: value => { if ('boundaryCompletion' in value) this.lastOutcome = value; this.statusText = this.statusLabel(value.state); this.renderStatus();
          this.diagnostics.add({ phase: 'idle', status: value.state }); } });
      this.session = session; this.watchSession(session, config);
      this.settings.repositoryId = repository.repositoryId; await this.persistSettings();
      this.statusText = 'Подключено'; this.renderStatus();
    } catch (error) { await state?.close(); dav.dispose();
      const capabilityFailed=error instanceof Error&&error.message.startsWith('Capability check failed:');
      this.diagnostics.add({ phase: 'connect', status: 'blocked', code: error instanceof DavError ? error.kind : capabilityFailed?'Unsupported':'LocalIOFailure' });
      this.statusText = capabilityFailed?'Сервер не прошёл проверку безопасной записи':error instanceof DavError && ['Transient', 'UnknownWrite'].includes(error.kind) ? 'Нет соединения' : 'Подключение не завершено'; this.renderStatus(); throw error;
    } finally { this.connecting = false; }
  }
  private watchSession(session: Session, config: Settings) {
    const changed = (file: TAbstractFile, oldPath?: string, kind?: 'create' | 'rename' | 'delete') => {
      if (!('stat' in file)) {
        if (kind === 'rename' && oldPath) for (const child of this.app.vault.getFiles().filter(f => f.path.startsWith(file.path + '/'))) changed(child, oldPath + child.path.slice(file.path.length), 'rename');
        return;
      }
      if (kind === 'rename' && oldPath && session.ownRenames.get(oldPath) === file.path) { session.ownRenames.delete(oldPath); return; }
      if (kind !== 'rename' && classifyPath(file.path, config) !== 'sync') return;
      if (kind === 'rename' && oldPath && [file.path, oldPath].every(path => classifyPath(path, { ...config, include: [], exclude: [] }) === 'exclude')) return;
      const generation = ++session.generation;
      const expected = session.ownWrites.get(file.path); const path = file.path;
      if (expected) {
        session.ownWrites.delete(path);
        session.writes = session.writes.catch(() => {}).then(async () => {
          try { if (await this.app.vault.adapter.exists(path) && await hashBytes(await this.app.vault.adapter.readBinary(path)) === expected) return; } catch { /* A racing user change must remain dirty. */ }
          session.unsavedEvents.push({ generation, kind: 'modify', path }); session.unsavedEvents.sort((a,b) => a.generation-b.generation);
          await this.flushEvents(session, generation);
          if (config.autoSync && config.syncOnSave) void session.lifecycle.requestSync('change');
        });
        void session.writes.catch(() => {}); return;
      }
      session.unsavedEvents.push({ generation, kind: kind ?? 'modify', path: file.path, ...(oldPath ? { from: oldPath } : {}) });
      session.writes = session.writes.catch(() => {}).then(() => this.flushEvents(session, generation));
      void session.writes.catch(() => { this.statusText = 'Не удалось сохранить журнал'; this.renderStatus(); });
      if (config.autoSync && config.syncOnSave) void session.lifecycle.requestSync('change');
    };
    for (const ref of [this.app.vault.on('modify', file => changed(file)), this.app.vault.on('create', file => changed(file, undefined, 'create')),
      this.app.vault.on('delete', file => changed(file,undefined,'delete')), this.app.vault.on('rename', (file, old) => changed(file, old, 'rename'))]) session.disposeEvents.push(() => this.app.vault.offref(ref));
    if (session.bookmarks) session.disposeEvents.push(session.bookmarks.onChanged(() => {
      const generation = ++session.generation;
      session.unsavedEvents.push({ generation, kind: 'rescan', path: bookmarksKey });
      session.writes = session.writes.catch(() => {}).then(() => this.flushEvents(session, generation));
      void session.writes.catch(() => {});
      if (config.autoSync && config.syncOnSave) void session.lifecycle.requestSync('change');
    }));
  }
  private async flushEvents(session: Session, through: number) {
    while (session.unsavedEvents.length && session.unsavedEvents[0].generation <= through) {
      session.events = await session.state.recordDirtyEvent(session.unsavedEvents[0]); session.unsavedEvents.shift();
    }
  }
  async sync(integrity = false) {
    try { await this.connect(); const session = this.session!; const initial = session.firstSync; session.firstSync = false;
      return await session.lifecycle.requestSync(integrity || initial ? 'integrity' : 'manual'); }
    catch { this.noticeFailure(); return undefined; }
  }
  private migrationSource(root:string) {
    const config=validateSettings({...this.settings,root});
    if(isWithinPath(config.root,this.settings.root)||isWithinPath(this.settings.root,config.root))throw Error('Migration roots must be separate');
    return config;
  }
  async previewMigration(sourceRoot:string) {
    const config=this.migrationSource(sourceRoot);const source=createNativeDav(config,this.native);
    try{return {preview:await previewImportSource(source,config),sourceRoot:config.root,target:await targetKeyV2(this.settings)};}finally{source.dispose();}
  }
  async importMigration(request:{preview:MigrationPreview;sourceRoot:string;target:string}) {
    if(await targetKeyV2(this.settings)!==request.target)throw Error('Migration target changed');
    const config=this.migrationSource(request.sourceRoot);const source=createNativeDav(config,this.native);
    try {
      const data=await readLegacyImport(source,request.preview,config);
      await this.connect();const session=this.session!;
      return await session.lifecycle.exclusive(async()=>{
        const result=await importIntoV2(session.repository,session.state,session.dav,data,request.preview.fingerprint);
        session.firstSync=true;return result;
      });
    }finally{source.dispose();}
  }

  async stopSession() {
    const session = this.session; if (!session) return;
    session.lifecycle.dispose(); await session.lifecycle.idle(); await session.writes;
    await session.bookmarks?.flush(); session.bookmarks?.dispose(); await session.bookmarks?.settled();
    for (const stop of session.disposeEvents) stop(); await session.state.close(); session.dav.dispose(); this.session = undefined;
  }
  async exportDiagnostics() {
    const path = `WebDAV-Sync-diagnostics-${Date.now()}.json`;
    await this.app.vault.create(path, this.diagnostics.export()); new Notice(`Диагностика: ${path}`);
  }
  private statusLabel(state: string) { return ({ running: 'Синхронизация', closing: 'Завершение перед выходом', clean: 'Синхронизировано', conflicted: 'Конфликты сохранены', pending: 'Есть незавершённые изменения', blocked: 'Нужно внимание' } as Record<string, string>)[state] ?? state; }
  private renderStatus() { this.statusEl?.setText(`WebDAV: ${this.statusText}`); }
  private noticeFailure() { new Notice(`WebDAV Sync: ${this.statusText}. Подробности — в настройках и безопасной диагностике.`); }
  private installCloseGuard() {
    type NativeWindow = { on(name: string, fn: (e: { preventDefault(): void }) => void): void; removeListener(name: string, fn: unknown): void };
    let native: NativeWindow | undefined;
    const handler = (event: { preventDefault(): void }) => { if (!this.release && this.session) { event.preventDefault(); this.beginClose(); } };
    if (Platform.isDesktopApp) try {
      const require = (window as unknown as { require?: (id: string) => { getCurrentWindow(): NativeWindow } }).require;
      native = require?.('@electron/remote').getCurrentWindow(); native?.on('close', handler); this.guardAvailable = !!native;
    } catch { this.guardAvailable = false; }
    this.register(() => native?.removeListener('close', handler));
    this.registerDomEvent(window, 'beforeunload', event => {
      if (this.release || !this.session) return;
      event.preventDefault(); event.returnValue = false as unknown as string; event.stopImmediatePropagation(); this.beginClose();
    }, true);
  }
  private beginClose() {
    if (this.closeDialog || !this.session) return;
    const token = ++this.closeToken; this.closeDialog = new CloseModal(this); this.closeDialog.open();
    void this.session.lifecycle.close().then(result => {
      if (token !== this.closeToken) return;
      if (result.state === 'completed') this.releaseWindow(); else this.closeDialog?.blocked(result.outcome);
    });
  }
  cancelExit() { this.closeToken++; this.session?.lifecycle.cancelClose(); this.closeDialog = undefined; }
  retryExit() { const modal = this.closeDialog; this.closeDialog = undefined; modal?.finish(); this.beginClose(); }
  async exitWithRecovery() { if (this.session) await this.session.lifecycle.explicitRecoveryExit(); this.releaseWindow(); }
  private releaseWindow() { this.release = true; this.closeDialog?.finish(); this.closeDialog = undefined; window.close(); }
  onunload() {
    const session = this.session;
    if (session) { session.lifecycle.dispose(); for (const stop of session.disposeEvents) stop();
      session.bookmarks?.dispose();
      void session.lifecycle.idle().then(async () => { await session.writes.catch(() => {}); await session.bookmarks?.settled().catch(() => {});
        session.state.close(); session.dav.dispose(); }).catch(() => {}); }
  }
}
