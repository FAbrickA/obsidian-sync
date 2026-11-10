import { PluginSettingTab, Setting, Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type WebdavSync from './main.ts';
import type { Settings } from './settings.ts';
import type { RunOutcomeV2 as RunOutcome } from './v2-types.ts';
import { classifyPath } from './paths.ts';
import { equivalentHeads } from './v2-history.ts';
const strings = (text: string) => text.split('\n').map(v => v.trim()).filter(Boolean);
function showError() { new Notice('Операция не завершена. Проверьте статус, подключение и актуальность выбранной версии.'); }
export class SyncSettingsTab extends PluginSettingTab {
  private owner: WebdavSync;
  constructor(app: App, owner: WebdavSync) { super(app, owner); this.owner = owner; }
  display() {
    const el = this.containerEl; el.empty(); el.addClass('webdav-sync-ui'); const draft: Settings = structuredClone(this.owner.settings);
    el.createEl('h2', { text: 'WebDAV Sync Lab' });
    el.createEl('p', { text: `Кандидат ${this.owner.manifest.version}. Windows и Mail.ru проверены на отдельном стенде. Linux и Android ещё требуют испытаний. Начните с отдельного тестового хранилища и папки WebDAV.` });
    el.createEl('p', { text: `Статус: ${this.owner.statusText}` });
    for (const [key, title] of [['endpoint', 'HTTPS WebDAV'], ['root', 'Папка на сервере'], ['username', 'Логин'], ['password', 'Пароль приложения']] as const) {
      new Setting(el).setName(title).addText(input => { input.setValue(draft[key]).onChange(value => { draft[key] = value; }); input.inputEl.autocomplete = 'off'; if (key === 'password') input.inputEl.type = 'password'; });
    }
    new Setting(el).setName('Репозиторий').addDropdown(input=>input.addOptions({'attach-v2':'Подключить существующий v2','create-v2':'Создать v2 в пустой папке'}).setValue(draft.repositoryMode).onChange(value=>{draft.repositoryMode=value as Settings['repositoryMode'];}));
    const secretStore = !!(this.app as unknown as { secretStorage?: unknown }).secretStorage;
    new Setting(el).setName('Запоминать пароль').setDesc(secretStore ? 'Используется хранилище секретов Obsidian.' : 'На этой версии Obsidian пароль будет сохранён в локальном файле настроек без шифрования. По умолчанию хранится только в памяти.').addToggle(toggle => toggle.setValue(draft.rememberPassword).onChange(value => { draft.rememberPassword = value; }));
    for (const [key, title] of [['autoSync', 'Синхронизация при изменениях и в фоне'], ['syncOnStartup', 'При запуске'], ['syncOnSave', 'После сохранения'], ['syncOnFocus', 'При возвращении в окно'], ['bookmarks', 'Закладки']] as const) {
      new Setting(el).setName(title).addToggle(toggle => toggle.setValue(draft[key]).onChange(value => { draft[key] = value; }));
    }
    for (const [key, title] of [['intervalSeconds', 'Проверка сервера, секунд'], ['debounceMs', 'Задержка после правки, мс'], ['concurrency', 'Параллельные передачи'], ['deletionGuardPercent', 'Предел массового удаления, %']] as const) {
      new Setting(el).setName(title).addText(input => input.setValue(String(draft[key])).onChange(value => { draft[key] = Number(value); }));
    }
    for (const [key, title] of [['include', 'Включать папки/пути: один префикс на строку, пусто — всё'], ['exclude', 'Исключать папки/пути: один префикс на строку']] as const) {
      new Setting(el).setName(title).addTextArea(input => input.setValue(draft[key].join('\n')).onChange(value => { draft[key] = strings(value); }));
    }
    new Setting(el).setName('Предпросмотр фильтров').addButton(button => button.setButtonText('Показать').onClick(() => {
      try { const files = this.app.vault.getFiles(); const included = files.filter(f => classifyPath(f.path, draft) === 'sync'); new Notice(`Выбрано: ${included.length}; исключено: ${files.length - included.length}. Настройки плагинов не синхронизируются.`); } catch { showError(); }
    }));
    new Setting(el).addButton(button => button.setButtonText('Сохранить и подключить').setCta().onClick(async () => {
      button.setDisabled(true);
      try { await this.owner.saveConfiguration(draft); await this.owner.connect(); new Notice('Подключено. Можно выполнить первую синхронизацию.'); }
      catch { showError(); } finally { button.setDisabled(false); this.display(); }
    })).addButton(button => button.setButtonText('Синхронизировать').onClick(async () => { button.setDisabled(true); await this.owner.sync(); button.setDisabled(false); this.display(); }));
    new Setting(el).addButton(button => button.setButtonText('Конфликты').onClick(() => new ConflictsModal(this.owner).open()))
      .addButton(button => button.setButtonText('История').onClick(() => new HistoryModal(this.owner).open()))
      .addButton(button => button.setButtonText('Проверка целостности').onClick(async () => { await this.owner.sync(true); this.display(); }));
    new Setting(el).setName('Предпросмотр первой синхронизации').addButton(button=>button.setButtonText('Показать план').onClick(async()=>{
      try{await this.owner.connect();const plan=await this.owner.session!.engine.previewAdoption();const modal=new Modal(this.app);
        modal.contentEl.createEl('h2',{text:'Локальные файлы при подключении'});
        modal.contentEl.createEl('pre',{text:JSON.stringify(plan,null,2)});modal.open();}catch{showError();}
    }));
    new Setting(el).setName('Импорт старого WebDAV').setDesc('Сначала сохраните настройки отдельной новой папки назначения. Исходная папка доступна только для чтения.').addButton(button=>button.setButtonText('Предпросмотр импорта').onClick(()=>new MigrationModal(this.owner).open()));
    if (this.owner.lastOutcome) {
      const result = this.owner.lastOutcome;
      el.createEl('p', { text: `Ревизия: ${result.publishedEventIds[0]?.slice(0, 12) ?? '—'}; локально применено: ${result.localApplied ? 'да' : 'ожидает'}; дерево сверено: ${result.projectionChecked ? 'да' : 'ожидает'}.` });
    }
  }
}
class MigrationModal extends Modal {
  private owner:WebdavSync;
  constructor(owner:WebdavSync){super(owner.app);this.owner=owner;}
  onOpen(){
    this.contentEl.createEl('h2',{text:'Импорт в отдельную папку WebDAV'});let sourceRoot='';let ready=false;
    this.contentEl.createEl('p',{text:`Назначение: ${this.owner.settings.root}. Импорт не меняет локальные заметки и не удаляет исходные файлы.`});
    new Setting(this.contentEl).setName('Старая папка WebDAV').addText(input=>input.onChange(value=>{sourceRoot=value;}));
    new Setting(this.contentEl).setName('Резервная копия создана, старые синхронизаторы остановлены на всех устройствах').addToggle(toggle=>toggle.onChange(value=>{ready=value;}));
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Прочитать и показать план').onClick(async()=>{
      button.setDisabled(true);try {
        const request=await this.owner.previewMigration(sourceRoot);
        const result=this.contentEl.createDiv();result.createEl('p',{text:`Файлов: ${request.preview.files.length}; байт: ${request.preview.bytes}; отпечаток: ${request.preview.fingerprint.slice(0,16)}.`});
        const details=result.createEl('details');details.createEl('summary',{text:'Пути и хеши'});
        details.createEl('pre',{text:request.preview.files.map(f=>`${f.path}: ${f.hash}`).join('\n')});
        new Setting(result).addButton(importButton=>importButton.setButtonText('Импортировать этот план в новую папку').onClick(async()=>{
          if(!ready){new Notice('Сначала создайте резервную копию и остановите старые writers.');return;}
          importButton.setDisabled(true);try{await this.owner.importMigration(request);new Notice('Импорт проверен. Теперь выполните обычную синхронизацию.');this.close();}catch{showError();importButton.setDisabled(false);}
        }));
      }catch{showError();}finally{button.setDisabled(false);}
    }));
  }
}
export class ConflictsModal extends Modal {
  private owner: WebdavSync;
  constructor(owner: WebdavSync) { super(owner.app); this.owner = owner; }
  async onOpen() {
    this.contentEl.empty(); this.contentEl.addClass('webdav-sync-ui'); this.contentEl.createEl('h2', { text: 'Конфликты и внешние изменения' });
    const session = this.owner.session; if (!session) { this.contentEl.createEl('p', { text: 'Сначала подключитесь к серверу.' }); return; }
    try {
      for (const conflict of await session.engine.conflicts()) {
        const path=conflict.variants[0].core.value.path,reviewedIds=conflict.variants.map(r=>r.id);
        this.contentEl.createEl('h3',{text:path});this.contentEl.createEl('p',{text:conflict.reason});
        const selected=new Set(reviewedIds);
        for(const variant of conflict.variants) {
          const value=variant.core.value,box=this.contentEl.createEl('details');box.createEl('summary',{text:variant.id.slice(0,12)+' — '+value.path+(value.kind==='tombstone'?' (удалено)':'')});
          new Setting(box).setName('Включить в разрешаемые варианты').addToggle(input=>input.setValue(true).onChange(on=>{if(on)selected.add(variant.id);else selected.delete(variant.id);}));
          if(value.kind==='file') {const preview=box.createEl('pre',{text:'Раскройте для загрузки',cls:'webdav-sync-preview'});let loaded=false;
            box.ontoggle=async()=>{if(!box.open||loaded)return;try{const bytes=await session.engine.readVersion(variant.id);let text;
              try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text='Двоичный файл: '+bytes.byteLength+' байт';}
              preview.setText(text);loaded=true;}catch{showError();}};}
          new Setting(box).addButton(button=>button.setButtonText('Выбрать эту версию').onClick(async()=>{
            button.setDisabled(true);try{await session.lifecycle.resolveConflict({fileId:conflict.fileId,reviewedIds:[...selected],choice:{kind:'variant',revisionId:variant.id}});await this.onOpen();}catch{showError();button.setDisabled(false);}
          }));
        }
        if(/\.md$/i.test(path)||path==='@bookmarks.json') {
          let text='';new Setting(this.contentEl).setName('Итоговый текст выбранных вариантов').addTextArea(input=>input.onChange(value=>{text=value;}));
          new Setting(this.contentEl).addButton(button=>button.setButtonText('Сохранить итог').onClick(async()=>{
            button.setDisabled(true);try{const reviewedIds=[...selected],bytes=new TextEncoder().encode(text).buffer,hash=await import('./snapshots.ts').then(m=>m.hashBytes(bytes));
              await session.state.storeObjects({[hash]:bytes});await session.state.setMeta('resolution:'+conflict.id,{id:conflict.id,hash,path});
              const result=await session.lifecycle.resolveConflict({fileId:conflict.fileId,reviewedIds,choice:{kind:'edit',path,bytes}});
              if(result.state!=='pending'&&result.state!=='blocked')await session.state.setMeta('resolution:'+conflict.id,null);await this.onOpen();
            }catch{showError();button.setDisabled(false);}
          }));
        }
      }
      const view=await session.engine.currentView();
      const groups:{fileIds:string[];paths:string[];local:boolean}[]=view.pathConflicts.map(c=>({...c,local:false}));
      for(const issue of this.owner.lastOutcome?.pending??[])if(issue.kind==='local'&&issue.code==='Collision'){
        const fileIds=issue.relatedIds.filter(id=>view.headsByFile[id]?.length);if(fileIds.length)groups.push({fileIds,paths:fileIds.flatMap(id=>view.headsByFile[id].map(r=>r.core.value.path)),local:true});
      }
      for(const conflict of groups) {
        this.contentEl.createEl('h3',{text:'Конфликт путей: '+conflict.paths.join(', ')});
        if(conflict.fileIds.some(id=>!equivalentHeads(view.headsByFile[id]))){
          this.contentEl.createEl('p',{text:'Сначала разрешите конфликт версий этих файлов выше. Затем выберите пути. Переименование не выбирает содержимое автоматически.'});
          continue;
        }
        if(conflict.local)this.contentEl.createEl('p',{text:'Перемещения образуют цикл. Выберите хотя бы для одного файла свободный промежуточный путь. Исходники сохраняются; позднее файл можно переименовать обратно.'});
        const requests=conflict.fileIds.map(fileId=>{const heads=view.headsByFile[fileId],first=heads[0],value=first.core.value;
          return{fileId,reviewedIds:heads.map(r=>r.id),revisionId:first.id,path:value.path,deleted:value.kind==='tombstone'};});
        for(const r of requests) new Setting(this.contentEl).setName(r.fileId.slice(0,12)).setDesc('Назначьте каждому файлу отдельный путь либо подтвердите удаление. Все версии останутся в истории.')
          .addText(input=>input.setValue(r.path).onChange(path=>{r.path=path;})).addToggle(input=>input.setValue(r.deleted).setTooltip('Удалить').onChange(value=>{r.deleted=value;}));
        new Setting(this.contentEl).addButton(button=>button.setButtonText('Применить выбранные пути').onClick(async()=>{
          button.setDisabled(true);try{const frozen=structuredClone(requests),rows:Parameters<typeof session.engine.resolvePaths>[0]=[];
            for(const r of frozen)rows.push({fileId:r.fileId,reviewedIds:r.reviewedIds,choice:r.deleted?{kind:'delete' as const,path:r.path}:{kind:'edit' as const,path:r.path,bytes:await session.engine.readVersion(r.revisionId)}});
            await session.lifecycle.exclusive(()=>session.engine.resolvePaths(rows));await this.onOpen();
          }catch{showError();button.setDisabled(false);}
        }));
      }
      for (const drift of await session.projection.drifts()) {
        this.contentEl.createEl('h3', { text: `Внешнее изменение: ${drift.path}` });
        this.contentEl.createEl('p', { text: 'Неизвестная версия заархивирована. Остановите другие программы, записывающие в эту папку WebDAV, перед выбором.' });
        new Setting(this.contentEl).addButton(button => button.setButtonText('Импортировать как новую версию').onClick(async () => { await session.lifecycle.resolveDrift(drift.id, 'import-as-edit'); await this.onOpen(); }))
          .addButton(button => button.setButtonText('Восстановить дерево из истории').onClick(async () => { await session.lifecycle.resolveDrift(drift.id, 'repair-from-canonical'); await this.onOpen(); }));
      }
      const quarantines=Object.values(await session.state.listMeta<{path:string;reason:string;archiveId:string;hash:string;active?:boolean}>('quarantine:')).filter(q=>q.active!==false);
      for(const copy of quarantines){
        this.contentEl.createEl('h3',{text:'Локальная копия требует решения: '+copy.path});
        this.contentEl.createEl('p',{text:'Причина: '+copy.reason+'. Копия сохранена в архиве; она не восстановит удалённый файл автоматически.'});
        this.contentEl.createEl('p',{text:'Чтобы сохранить её как новую заметку, переименуйте исходный локальный файл в свободный путь синхронизируемой папки. Чтобы принять серверное удаление, удалите исходный локальный файл. Затем выполните синхронизацию; архив останется доступен в истории.'});
        new Setting(this.contentEl).addButton(button=>button.setButtonText('Извлечь локальную копию из архива').onClick(async()=>{
          button.setDisabled(true);try{
            const archive=(await session.projection.archives()).find(a=>a.id===copy.archiveId&&a.hash===copy.hash);if(!archive)throw Error('Archive unavailable');
            const extension=copy.path.split('/').pop()!.match(/\.[^.]+$/)?.[0]??'.bin',path='Recovered-quarantine-'+crypto.randomUUID()+extension;
            await this.app.vault.createBinary(path,await session.repository.readSlot(archive.blob.slot));new Notice('Восстановлено: '+path);
          }catch{showError();}finally{button.setDisabled(false);}
        }));
      }
      if (!(await session.engine.conflicts()).length && !groups.length && !(await session.projection.drifts()).length && !quarantines.length) this.contentEl.createEl('p', { text: 'Конфликтов нет.' });
    } catch { showError(); }
  }
}
export class HistoryModal extends Modal {
  private owner: WebdavSync;
  constructor(owner: WebdavSync) { super(owner.app); this.owner = owner; }
  async onOpen() {
    this.contentEl.empty(); this.contentEl.addClass('webdav-sync-ui'); this.contentEl.createEl('h2', { text: 'История версий' }); const session = this.owner.session;
    if (!session) { this.contentEl.createEl('p', { text: 'Сначала подключитесь.' }); return; }
    try {
      const view=await session.engine.currentView();
      for(const [fileId,heads]of Object.entries(view.headsByFile)) {
        const group=this.contentEl.createEl('details');group.createEl('summary',{text:heads.map(r=>r.core.value.path+(r.core.value.kind==='tombstone'?' (удалено)':'')).join(', ')});
        const load=group.createEl('button',{text:'Загрузить версии'});load.onclick=async()=>{load.disabled=true;try{
          for(const version of await session.engine.history(fileId)) {
            const value=version.core.value;
            new Setting(group).setName(version.id.slice(0,12)+' — '+version.core.operation+' — '+value.path)
              .setDesc(value.kind==='file'?value.hash.slice(0,16)+'; '+value.size+' байт':'Удалено')
              .addButton(button=>button.setButtonText('Восстановить новой версией').setDisabled(value.kind==='tombstone').onClick(async()=>{
                try{await session.lifecycle.restoreVersion(fileId,version.id,heads.map(r=>r.id));new Notice('Проверьте статус восстановления.');}catch{showError();}
              }));
          }
        }catch{showError();}};
      }
      this.contentEl.createEl('h3',{text:'Архивы внешних изменений и отдельных копий'});
      for(const archive of await session.projection.archives())new Setting(this.contentEl).setName(archive.path+' — '+archive.hash.slice(0,12)).addButton(button=>button.setButtonText('Извлечь отдельной копией').onClick(async()=>{
        try{const extension=archive.path.split('/').pop()!.match(/\.[^.]+$/)?.[0]??'.bin',path='Recovered-external-'+crypto.randomUUID()+extension;
          await this.app.vault.createBinary(path,await session.repository.readSlot(archive.blob.slot));new Notice('Восстановлено: '+path);}catch{showError();}
      }));
      for(const draft of Object.values(await session.state.listMeta<{id:string;hash:string;path?:string}|null>('resolution:')))if(draft){
        new Setting(this.contentEl).setName(`Сохранённый итог конфликта: ${draft.path??draft.id}`).addButton(button=>button.setButtonText('Извлечь отдельной копией').onClick(async()=>{
          try{const path=`Recovered-conflict-${crypto.randomUUID()}.md`;await this.app.vault.createBinary(path,await session.state.readObject(draft.hash));new Notice(`Восстановлено: ${path}`);}catch{showError();}
        }));
      }
      for (const effect of Object.values(await session.state.listMeta<{ backup: string; source: string }>('local-effect:'))) {
        if (!await this.app.vault.adapter.exists(effect.backup)) continue;
        new Setting(this.contentEl).setName(effect.source).addButton(button => button.setButtonText('Восстановить отдельной копией').onClick(async () => {
          try { const original = effect.source; const dot = original.lastIndexOf('.'); const target = `${dot >= 0 ? original.slice(0, dot) : original}.recovered-${crypto.randomUUID()}${dot >= 0 ? original.slice(dot) : ''}`;
            await this.app.vault.createBinary(target, await this.app.vault.adapter.readBinary(effect.backup)); new Notice(`Восстановлено: ${target}`); } catch { showError(); }
        }));
      }
      this.contentEl.createEl('p', { text: 'История и исходники сохраняются. Автоматической очистки версий нет.' });
      const storage=await navigator.storage?.estimate();if(storage)this.contentEl.createEl('p',{text:`Локальное хранилище всего Obsidian: ${storage.usage??0} из ${storage.quota??0} байт. Это общая квота, включая другие плагины.`});
    } catch { showError(); }
  }
}
export class CloseModal extends Modal {
  private cancel = true;
  private owner: WebdavSync;
  constructor(owner: WebdavSync) { super(owner.app); this.owner = owner; }
  onOpen() {
    this.contentEl.addClass('webdav-sync-ui');
    this.contentEl.createEl('h2', { text: 'Завершение синхронизации' });
    this.contentEl.createEl('p', { text: 'Obsidian закроется после передачи и локального checkpoint. Новые изменения других устройств не продлевают ожидание бесконечно.' });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Отменить выход').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Сохранить локально и выйти с восстановлением').onClick(async () => { try { await this.owner.exitWithRecovery(); } catch { new Notice('Локальное сохранение не завершено. Выход удерживается.'); } }));
  }
  blocked(outcome: RunOutcome) {
    this.contentEl.createEl('p', { text: `Синхронизация ожидает решения: ${outcome.pending.map(p=>p.code).join(', ')}` });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Повторить').onClick(() => this.owner.retryExit()));
  }
  finish() { this.cancel = false; this.close(); }
  onClose() { if (this.cancel) this.owner.cancelExit(); this.contentEl.empty(); }
}
