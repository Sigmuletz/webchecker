(function(){
'use strict';

const GLOBAL_VAR_KEYS = ['KVNR','TENANT','ENV'];
const FIXED_KEYS = new Set(GLOBAL_VAR_KEYS);

/* ── State ── */
let token      = localStorage.getItem('auth_token') || '';
let running    = false;
let activeWs   = null;
let libraries  = {};
let selected   = null;
let sessions   = {};
let customVars = []; // [{id, key, value}]
let varIdCounter = 0;
let favorites  = { scripts: [], libraries: {} };
let editMode   = false;
let editOriginalTemplate = '';
let editOriginalDestination = '';
let libHoverMode = localStorage.getItem('lib_hover_mode') !== 'false';
let bgPollTimer = null;
let tabs = new Map();
let activeTabId = 'main';
let tabCounter = 0;
let workspaces = [];
let activeWorkspaceId = 'default';
let smartParams = {};

/* ── Elements ── */
const tokenModal   = document.getElementById('token-modal');
const tokenInput   = document.getElementById('token-input');
const tokenSubmit  = document.getElementById('token-submit');
const tokenError   = document.getElementById('token-error');
const actionPanel  = document.getElementById('action-panel');
const paramsWrap   = document.getElementById('inline-params-wrap');
const execBtn      = document.getElementById('exec-btn');
const previewCmd   = document.getElementById('preview-cmd');
const scriptList   = document.getElementById('script-list');
const libSections  = document.getElementById('library-sections');
const output       = document.getElementById('output');
const outputWrap   = document.getElementById('output-wrap');
const emptyState   = document.getElementById('empty-state');
const spinner      = document.getElementById('spinner');
const exitBadge    = document.getElementById('exit-badge');
const clearBtn     = document.getElementById('clear-btn');
const killBtn      = document.getElementById('kill-btn');
const settingsBtn  = document.getElementById('settings-btn');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const terminalTitle    = document.getElementById('terminal-title');
const scriptsCount     = document.getElementById('scripts-count');
const scriptsSectionHeader = document.getElementById('scripts-section-header');
const sessionInput   = document.getElementById('session-input');
const sessionDropdown= document.getElementById('session-dropdown');
const sessionSaveBtn = document.getElementById('session-save-btn');
const sessionDelBtn  = document.getElementById('session-del-btn');
let   activeSessionId= '';
const customVarsEl    = document.getElementById('custom-vars');
const addVarBtn       = document.getElementById('add-var-btn');
const editBtn            = document.getElementById('edit-btn');
const editSaveBtn        = document.getElementById('edit-save-btn');
const editCancelBtn      = document.getElementById('edit-cancel-btn');
const editTemplateRow    = document.getElementById('edit-template-row');
const editTemplateArea   = document.getElementById('edit-template-area');
const editError          = document.getElementById('edit-error');
const previewLabel       = document.getElementById('preview-label');
const interactiveBtn     = document.getElementById('interactive-btn');
const bgBtn              = document.getElementById('bg-btn');
const bgList             = document.getElementById('bg-list');
const tabBar             = document.getElementById('tab-bar');
const interactiveBar     = document.getElementById('interactive-bar');
const interactiveInput   = document.getElementById('interactive-input');
const interactiveSendBtn = document.getElementById('interactive-send-btn');
const interactiveCloseBtn= document.getElementById('interactive-close-btn');
const actionDestRow      = document.getElementById('action-dest-row');
const scriptArgsRow      = document.getElementById('script-args-row');
const scriptArgsInput    = document.getElementById('script-args-input');
const execCmdCode        = document.getElementById('exec-cmd-code');
const argsPresetBtn      = document.getElementById('args-preset-btn');
const argsPresetDropdown = document.getElementById('args-preset-dropdown');
const editArgsListRow    = document.getElementById('edit-args-list-row');
const editArgsList       = document.getElementById('edit-args-list');
const addArgPresetBtn    = document.getElementById('add-arg-preset-btn');
scriptArgsInput.addEventListener('input', refreshPreviewCmd);
let scriptArgPresets = [];
const libHoverToggle     = document.getElementById('lib-hover-toggle');
const sidebarEl          = document.getElementById('sidebar');
const destView           = document.getElementById('dest-view');
const destEditInput      = document.getElementById('dest-edit-input');
const workspaceBar       = document.getElementById('workspace-bar');
const wsBtn              = document.getElementById('ws-btn');
const wsNameEl           = document.getElementById('ws-name');
const wsDropdown         = document.getElementById('ws-dropdown');

/* ── Auth helper — token in Authorization header, not query string ── */
function apiFetch(url, opts = {}) {
  opts.headers = { 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) };
  return fetch(url, opts);
}

/* ── Favorites ── */
function loadFavorites(){
  try{ favorites=JSON.parse(localStorage.getItem('favorites')||'{"scripts":[],"libraries":{}}'); }
  catch(e){ console.error('loadFavorites:', e); favorites={scripts:[],libraries:{}}; }
  if(!Array.isArray(favorites.scripts)) favorites.scripts=[];
  if(typeof favorites.libraries!=='object') favorites.libraries={};
}

function saveFavorites(){ localStorage.setItem('favorites',JSON.stringify(favorites)); }
function isFavScript(name){ return favorites.scripts.includes(name); }
function isFavLib(filename,entryName){ return (favorites.libraries[filename]||[]).includes(entryName); }

function toggleFavScript(name){
  if(isFavScript(name)) favorites.scripts=favorites.scripts.filter(n=>n!==name);
  else favorites.scripts.push(name);
  saveFavorites(); renderScriptsAndFavs(); renderFavoritesSection();
  if(window.refreshFilter) refreshFilter();
}

function toggleFavLib(filename,entryName){
  const arr=favorites.libraries[filename]||(favorites.libraries[filename]=[]);
  if(isFavLib(filename,entryName)) favorites.libraries[filename]=arr.filter(n=>n!==entryName);
  else arr.push(entryName);
  saveFavorites(); renderLibrarySections(); renderFavoritesSection();
  if(window.refreshFilter) refreshFilter();
}

function renderFavoritesSection(){
  const list=document.getElementById('favorites-list');
  const countEl=document.getElementById('favorites-count');
  list.innerHTML='';
  let total=0;

  favorites.scripts.forEach(name=>{
    const el=buildScriptItemEl(name,{
      favd:true,
      onFav:()=>toggleFavScript(name),
      onRun:()=>{ if(!running) runScript(name,el); },
      onPrev:()=>{ if(!running) selectScript(name,el); },
      onClick:()=>{ if(!running) selectScript(name,el); }
    });
    list.appendChild(el); total++;
  });

  Object.entries(favorites.libraries).forEach(([filename,entryNames])=>{
    entryNames.forEach(entryName=>{
      const lib=libraries[filename]; if(!lib) return;
      const entry=lib.entries.find(e=>e.name===entryName); if(!entry) return;
      const el=buildLibItemEl(lib.category+' / '+entryName,{
        favd:true,
        onFav:()=>toggleFavLib(filename,entryName),
        onRun:()=>{ if(!running) execLibraryDirect(filename,entry); },
        onPrev:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); },
        onClick:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); }
      });
      list.appendChild(el); total++;
    });
  });

  countEl.textContent=total;
}

/* ── Custom Vars ── */
function renderCustomVars(){
  customVarsEl.innerHTML='';
  customVars.forEach(cv=>{
    const row=document.createElement('div');
    row.className='custom-var-row';

    const keyInp=document.createElement('input');
    keyInp.className='custom-var-key'; keyInp.type='text';
    keyInp.value=cv.key; keyInp.placeholder='KEY';
    keyInp.maxLength=40; keyInp.spellcheck=false; keyInp.autocomplete='off';
    row.appendChild(keyInp);

    const sp=smartParams[cv.key];
    if(sp){
      const combo=_buildSmartComboWrap(cv.key,null,'custom-var-val',cv.value,sp,
        (val)=>{ cv.value=val; refreshPreviewCmd(); }
      );
      row.appendChild(combo);
    } else {
      const valInp=document.createElement('input');
      valInp.className='custom-var-val'; valInp.type='text';
      valInp.value=cv.value; valInp.placeholder='value';
      valInp.spellcheck=false; valInp.autocomplete='off';
      valInp.addEventListener('input',()=>{ cv.value=valInp.value; refreshPreviewCmd(); });
      row.appendChild(valInp);
    }

    const removeBtn=document.createElement('button');
    removeBtn.className='custom-var-remove'; removeBtn.title='Remove'; removeBtn.textContent='×';
    removeBtn.addEventListener('click',()=>{
      customVars=customVars.filter(x=>x.id!==cv.id); row.remove(); refreshPreviewCmd();
    });
    row.appendChild(removeBtn);

    const prevKey=cv.key;
    keyInp.addEventListener('input',()=>{
      cv.key=keyInp.value.toUpperCase().replace(/[^A-Z0-9_]/g,'');
      keyInp.value=cv.key; refreshPreviewCmd();
    });
    keyInp.addEventListener('blur',()=>{
      const hadSp=!!smartParams[prevKey]; const hasSp=!!smartParams[cv.key];
      if(hadSp!==hasSp) renderCustomVars();
    });

    customVarsEl.appendChild(row);
  });
}

addVarBtn.addEventListener('click',()=>{
  const cv={id:varIdCounter++,key:'',value:''};
  customVars.push(cv);
  renderCustomVars();
  customVarsEl.querySelector('.custom-var-row:last-child .custom-var-key')?.focus();
});

/* ── Global Vars ── */
function getGlobalVars(){
  const v={};
  GLOBAL_VAR_KEYS.forEach(k=>{
    const val=(document.getElementById('gvar-'+k)?.value||'').trim();
    if(val) v[k]=val;
  });
  customVars.forEach(({key,value})=>{
    const k=key.trim();
    if(k&&value.trim()) v[k]=value.trim();
  });
  return v;
}

/* ── Sessions ── */
function currentSessionId(){
  const tenant=(document.getElementById('gvar-TENANT')?.value||'').trim();
  const kvnr=(document.getElementById('gvar-KVNR')?.value||'').trim();
  return (tenant&&kvnr)?`${tenant}_${kvnr}`:null;
}

function setActiveSession(id){
  activeSessionId=id;
  sessionInput.value=id||'';
}

function populateSessionDropdown(q){
  const filter=(q||'').toLowerCase();
  const keys=Object.keys(sessions).sort().filter(id=>!filter||id.toLowerCase().includes(filter));
  sessionDropdown.innerHTML='';
  if(!keys.length){
    const d=document.createElement('div'); d.className='sess-opt-empty'; d.textContent='no sessions';
    sessionDropdown.appendChild(d); return;
  }
  keys.forEach(id=>{
    const d=document.createElement('div');
    d.className='sess-opt'+(id===activeSessionId?' sel':''); d.textContent=id;
    d.addEventListener('mousedown',e=>e.preventDefault());
    d.addEventListener('click',()=>{ applySession(id); sessionDropdown.classList.remove('open'); });
    sessionDropdown.appendChild(d);
  });
}

function renderSessionDropdown(){
  const cur=currentSessionId();
  if(!activeSessionId||!sessions[activeSessionId]){
    setActiveSession(cur&&sessions[cur]?cur:'');
  }
  if(sessionDropdown.classList.contains('open')) populateSessionDropdown(sessionInput.value);
}

sessionInput.addEventListener('focus',()=>{ populateSessionDropdown(''); sessionDropdown.classList.add('open'); sessionInput.select(); });
sessionInput.addEventListener('blur',()=>{ setTimeout(()=>{ sessionDropdown.classList.remove('open'); sessionInput.value=activeSessionId||''; },160); });
sessionInput.addEventListener('input',()=>{ populateSessionDropdown(sessionInput.value); sessionDropdown.classList.add('open'); });
sessionInput.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ sessionDropdown.classList.remove('open'); sessionInput.value=activeSessionId||''; sessionInput.blur(); }
  if(e.key==='Enter'){
    const q=sessionInput.value.toLowerCase();
    const match=Object.keys(sessions).sort().find(id=>id.toLowerCase().includes(q));
    if(match){ applySession(match); sessionDropdown.classList.remove('open'); }
  }
});

function applySession(id){
  const vars=sessions[id]; if(!vars) return;
  GLOBAL_VAR_KEYS.forEach(k=>{
    const el=document.getElementById('gvar-'+k);
    if(el) el.value=vars[k]||'';
  });
  customVars=[];
  Object.entries(vars).forEach(([k,v])=>{
    if(!FIXED_KEYS.has(k)&&k&&v) customVars.push({id:varIdCounter++,key:k,value:v});
  });
  renderCustomVars();
  if(selected) buildInlineParams(selected.entry);
  refreshPreviewCmd();
  setActiveSession(id);
  renderSessionDropdown();
  localStorage.setItem('last_session_id',id);
  loadSessionLog(id);
}

async function loadSessions(){
  if(!token) return;
  try{
    const res=await apiFetch('/api/sessions');
    if(!res.ok) return;
    sessions=await res.json();
    renderSessionDropdown();
  }catch(e){ console.error('loadSessions:', e); }
}

async function restoreLastSession(){
  const lastId=localStorage.getItem('last_session_id');
  if(lastId&&sessions[lastId]) applySession(lastId);
}

/* ── Session Log ── */
async function loadSessionLog(id){
  if(!id||!token) return;
  try{
    const res=await apiFetch(`/api/logs/${encodeURIComponent(id)}`);
    if(!res.ok) return;
    const entries=await res.json();
    if(!entries.length){
      clearOutput('main'); emptyState.classList.remove('is-hidden');
      terminalTitle.textContent=''; const _sl=document.createElement('span'); _sl.textContent='SESSION LOG'; terminalTitle.appendChild(_sl);
      return;
    }
    renderSessionLog(entries);
    outputWrap.scrollTop=outputWrap.scrollHeight;
  }catch(e){ console.error('loadSessionLog:', e); }
}

function renderSessionLog(entries){
  clearOutput('main');
  terminalTitle.textContent=''; const _rs=document.createElement('span'); _rs.textContent='SESSION LOG'; terminalTitle.appendChild(_rs);
  entries.forEach(entry=>{
    appendPromptLine(entry.cat||null,entry.name,'main',entry.dest||'');
    appendLine('['+entry.ts+']\n','meta','main');
    if(entry.cmd) appendLine('$ '+entry.cmd+'\n','meta','main');
    entry.lines.forEach(l=>{ appendLine(l.d,l.t==='o'?'stdout':'stderr','main'); });
    appendLine('\n[exited with code '+entry.code+']\n\n','meta','main');
  });
}

async function doSaveSession(id,explicit){
  const vars=getGlobalVars(); if(!id) return;
  try{
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}`,{
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(vars)
    });
    sessions[id]=vars;
    localStorage.setItem('last_session_id',id);
    setActiveSession(id);
    renderSessionDropdown();
    if(explicit){
      sessionSaveBtn.textContent='SAVED';
      setTimeout(()=>{ sessionSaveBtn.textContent='SAVE'; },1200);
    }
  }catch(e){ console.error('doSaveSession:', e); }
}

sessionSaveBtn.addEventListener('click',()=>{
  const id=currentSessionId();
  if(!id){
    sessionSaveBtn.textContent='NEED TENANT+KVNR';
    setTimeout(()=>{ sessionSaveBtn.textContent='SAVE'; },1500);
    return;
  }
  doSaveSession(id,true);
});

document.getElementById('session-new-btn').addEventListener('click',()=>{
  setActiveSession('');
  GLOBAL_VAR_KEYS.forEach(k=>{ const el=document.getElementById('gvar-'+k); if(el) el.value=''; });
  customVars=[]; renderCustomVars();
  refreshPreviewCmd(); renderSessionDropdown();
});

sessionDelBtn.addEventListener('click',async()=>{
  const id=activeSessionId; if(!id) return;
  try{
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'});
    delete sessions[id];
    if(localStorage.getItem('last_session_id')===id) localStorage.removeItem('last_session_id');
    setActiveSession('');
    renderSessionDropdown();
  }catch(e){ console.error('sessionDel:', e); }
});

/* ── Token Modal ── */
function showTokenModal(err){
  tokenModal.classList.add('visible');
  tokenInput.value=''; tokenInput.classList.remove('error'); tokenError.classList.remove('visible');
  if(err){tokenInput.classList.add('error'); tokenError.classList.add('visible');}
  tokenInput.focus();
}
tokenSubmit.addEventListener('click',submitToken);
tokenInput.addEventListener('keydown',e=>{ if(e.key==='Enter') submitToken(); });

async function submitToken(){
  const val=tokenInput.value.trim(); if(!val) return;
  try{
    const res=await fetch('/api/scripts',{headers:{'Authorization':'Bearer '+val}});
    if(res.status===401){showTokenModal(true);return;}
    token=val; localStorage.setItem('auth_token',token);
    tokenModal.classList.remove('visible');
    renderScripts(await res.json());
    loadLibraries().then(renderFavoritesSection);
    await loadSessions();
    restoreLastSession();
    loadStatus().then(startStatusAutoRefresh);
    refreshJobs(); startBgPoll(); loadWorkspaces(); loadSmartParams();
  }catch(e){ console.error('submitToken:', e); showTokenModal(true); }
}
settingsBtn.addEventListener('click',()=>{
  localStorage.removeItem('auth_token');
  token='';
  if(statusRefreshTimer) clearInterval(statusRefreshTimer);
  if(bgPollTimer) clearInterval(bgPollTimer);
  showTokenModal(false);
});

/* ── Library Hover Mode ── */
function applyLibHoverMode(){
  if(libHoverMode){
    sidebarEl.classList.add('lib-hover');
    libHoverToggle.classList.add('hover-active');
    libHoverToggle.title='Library: hover-expand (click to switch)';
  } else {
    sidebarEl.classList.remove('lib-hover');
    libHoverToggle.classList.remove('hover-active');
    libHoverToggle.title='Library: click-expand (click to switch)';
  }
  localStorage.setItem('lib_hover_mode',String(libHoverMode));
}
libHoverToggle.addEventListener('click',()=>{ libHoverMode=!libHoverMode; applyLibHoverMode(); });
applyLibHoverMode();

/* ── Section Toggle ── */
scriptsSectionHeader.addEventListener('click',e=>{
  if(e.target.closest('.section-add-btn')) return;
  document.getElementById('scripts-section').classList.toggle('collapsed');
});
document.getElementById('new-script-btn').addEventListener('click',e=>{
  e.stopPropagation(); openCreateModal('script');
});
document.getElementById('favorites-section-header').addEventListener('click',e=>{
  if(e.target.closest('.section-add-btn')) return;
  document.getElementById('favorites-section').classList.toggle('collapsed');
});

/* ── Scripts ── */
async function loadScripts(){
  if(!token){showTokenModal(false);return;}
  try{
    const res=await apiFetch('/api/scripts');
    if(res.status===401){showTokenModal(true);return;}
    renderScripts(await res.json());
  }catch(e){ console.error('loadScripts:', e); }
}

let _lastScripts = [];
function renderScripts(scripts){ _lastScripts=scripts; renderScriptsAndFavs(); }

function renderScriptsAndFavs(){
  const scripts=_lastScripts;
  scriptList.innerHTML='';
  scriptsCount.textContent=scripts.length;
  scripts.forEach(name=>{
    const el=buildScriptItemEl(name,{
      favd:isFavScript(name),
      onFav:()=>toggleFavScript(name),
      onRun:()=>{ if(!running) runScript(name,el); },
      onPrev:()=>{ if(!running) selectScript(name,el); },
      onClick:()=>{ if(!running) selectScript(name,el); }
    });
    scriptList.appendChild(el);
  });
  renderFavoritesSection();
}

/* ── Libraries ── */
async function loadLibraries(){
  try{
    const res=await apiFetch('/api/libraries');
    if(!res.ok) return;
    libraries=await res.json();
    renderLibrarySections();
  }catch(e){ console.error('loadLibraries:', e); }
}

function renderLibrarySections(){
  libSections.innerHTML='';
  for(const [filename,lib] of Object.entries(libraries))
    libSections.appendChild(buildLibSection(filename,lib));
}

function buildLibSection(filename,lib){
  const section=document.createElement('div');
  section.className='sidebar-section lib-section';
  const header=document.createElement('div');
  header.className='section-header';
  const chev=document.createElement('span'); chev.className='section-chevron'; chev.textContent='▼';
  const sname=document.createElement('span'); sname.className='section-name'; sname.textContent=lib.category;
  const scnt=document.createElement('span'); scnt.className='section-count'; scnt.textContent=lib.entries.length;
  const sadd=document.createElement('button'); sadd.className='section-add-btn'; sadd.title='New entry'; sadd.setAttribute('aria-label','New entry in '+lib.category); sadd.textContent='+';
  header.append(chev,sname,scnt,sadd);
  sadd.addEventListener('click',e=>{
    e.stopPropagation(); openCreateModal('library',filename,lib.category);
  });
  header.addEventListener('click',e=>{
    if(e.target.closest('.section-add-btn')) return;
    if(!libHoverMode) section.classList.toggle('expanded');
  });
  const items=document.createElement('div');
  items.className='section-items';
  lib.entries.forEach(entry=>{
    const el=buildLibItemEl(entry.name,{
      favd:isFavLib(filename,entry.name),
      onFav:()=>toggleFavLib(filename,entry.name),
      onRun:()=>{ if(!running) execLibraryDirect(filename,entry); },
      onPrev:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); },
      onClick:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); }
    });
    items.appendChild(el);
  });
  section.appendChild(header);
  section.appendChild(items);
  return section;
}

/* ── Selection → Action Panel ── */
async function selectScript(name,itemEl){
  if(editMode) exitEditMode(true);
  try{
    const res=await apiFetch('/api/scripts/'+encodeURIComponent(name));
    if(!res.ok) return;
    const data=await res.json();
    selected={type:'script',name,itemEl,entry:{name,template:data.content,params:data.params}};
    setActive(itemEl,'script');
    showActionPanel('script',name,null,selected.entry);
    await loadScriptArgPresets(name);
  }catch(e){ console.error('selectScript:', e); }
}

function selectLibraryEntry(filename,category,entry){
  if(editMode) exitEditMode(true);
  selected={type:'library',filename,entry};
  showActionPanel('library',entry.name,category,entry);
}

function setTermTitle(type,name,cat){
  terminalTitle.textContent='';
  if(type==='script'||!cat){
    const s=document.createElement('span'); s.textContent=name; terminalTitle.appendChild(s);
  } else {
    const cs=document.createElement('span'); cs.className='title-cat'; cs.textContent=cat;
    const ns=document.createElement('span'); ns.textContent=name;
    terminalTitle.append(cs,' / ',ns);
  }
}

function showActionPanel(type,name,cat,entry){
  setTermTitle(type,name,cat);
  exitBadge.className=''; exitBadge.textContent='';
  editBtn.classList.remove('is-hidden');
  execBtn.classList.remove('is-hidden');
  interactiveBtn.classList.remove('is-hidden');
  bgBtn.classList.remove('is-hidden');
  editSaveBtn.classList.add('is-hidden'); editCancelBtn.classList.add('is-hidden');
  editTemplateRow.classList.add('is-hidden'); previewLabel.classList.add('is-hidden');
  editError.classList.remove('visible');
  if(type==='library'&&entry.destination){
    actionDestRow.classList.remove('is-hidden');
    /* renderTemplateHtml returns safe HTML — values are HTML-escaped */
    destView.innerHTML=renderTemplateHtml(entry.destination,getCurrentInlineParams());
    destView.classList.remove('is-hidden');
    destEditInput.classList.add('is-hidden');
  } else {
    actionDestRow.classList.add('is-hidden');
    destView.innerHTML='';
  }
  if(type==='script'){
    scriptArgsRow.classList.remove('is-hidden');
    scriptArgsInput.value='';
    argsPresetDropdown.classList.remove('open');
  } else {
    scriptArgsRow.classList.add('is-hidden');
    scriptArgPresets=[];
    argsPresetBtn.classList.remove('has-presets');
  }
  buildInlineParams(entry);
  refreshPreviewCmd();
  actionPanel.classList.add('visible');
  const first=paramsWrap.querySelector('.inline-param-input:not(.prefilled)');
  if(first) first.focus();
}

function hideActionPanel(){
  exitEditMode(false);
  actionPanel.classList.remove('visible');
  editBtn.classList.add('is-hidden');
  interactiveBtn.classList.add('is-hidden');
  bgBtn.classList.add('is-hidden');
  actionDestRow.classList.add('is-hidden');
  scriptArgsRow.classList.add('is-hidden');
  selected=null;
}

function enterEditMode(){
  if(!selected) return;
  editMode=true;
  editOriginalTemplate=selected.entry.template;
  editOriginalDestination=selected.entry.destination||'';
  editTemplateArea.value=selected.entry.template;
  editError.classList.remove('visible'); editError.textContent='';
  editTemplateRow.classList.remove('is-hidden');
  previewLabel.classList.remove('is-hidden');
  editBtn.classList.add('is-hidden');
  editSaveBtn.classList.remove('is-hidden');
  editCancelBtn.classList.remove('is-hidden');
  execBtn.classList.add('is-hidden');
  interactiveBtn.classList.add('is-hidden');
  bgBtn.classList.add('is-hidden');
  scriptArgsRow.classList.add('is-hidden');
  if(selected.type==='script'){
    editArgsListRow.classList.remove('is-hidden');
    renderEditArgsList();
  }
  if(selected.type==='library'){
    actionDestRow.classList.remove('is-hidden');
    destView.classList.add('is-hidden');
    destEditInput.value=selected.entry.destination||'';
    destEditInput.classList.remove('is-hidden');
  }
  editTemplateArea.focus();
}

function exitEditMode(restore){
  if(!editMode) return;
  editMode=false;
  editTemplateRow.classList.add('is-hidden');
  previewLabel.classList.add('is-hidden');
  editSaveBtn.classList.add('is-hidden');
  editCancelBtn.classList.add('is-hidden');
  execBtn.classList.remove('is-hidden');
  interactiveBtn.classList.remove('is-hidden');
  bgBtn.classList.remove('is-hidden');
  if(restore&&selected){
    selected.entry.template=editOriginalTemplate;
    selected.entry.params=extractParams(editOriginalTemplate);
    selected.entry.destination=editOriginalDestination;
    buildInlineParams(selected.entry);
    refreshPreviewCmd();
  }
  if(selected&&selected.type==='library'){
    const dest=selected.entry.destination||'';
    if(dest){
      actionDestRow.classList.remove('is-hidden');
      /* renderTemplateHtml returns safe HTML — values are HTML-escaped */
      destView.innerHTML=renderTemplateHtml(dest,getCurrentInlineParams());
      destView.classList.remove('is-hidden');
      destEditInput.classList.add('is-hidden');
    } else {
      actionDestRow.classList.add('is-hidden');
    }
  } else {
    actionDestRow.classList.add('is-hidden');
  }
  editArgsListRow.classList.add('is-hidden');
  if(selected&&selected.type==='script') scriptArgsRow.classList.remove('is-hidden');
  if(selected) editBtn.classList.remove('is-hidden');
}

function extractParams(template){
  return [...new Set((template.match(/\{\{([A-Z_0-9]+)\}\}/g)||[]).map(m=>m.slice(2,-2)))].sort();
}

editBtn.addEventListener('click', enterEditMode);
editCancelBtn.addEventListener('click',()=>exitEditMode(true));

editTemplateArea.addEventListener('input',()=>{
  if(!selected) return;
  selected.entry.template=editTemplateArea.value;
  selected.entry.params=extractParams(editTemplateArea.value);
  buildInlineParams(selected.entry);
  refreshPreviewCmd();
});

editSaveBtn.addEventListener('click',async()=>{
  if(!selected) return;
  const newContent=editTemplateArea.value;
  if(!newContent.trim()){ editError.textContent='Content required.'; editError.classList.add('visible'); return; }
  editSaveBtn.disabled=true;
  editError.classList.remove('visible');
  try{
    let res;
    if(selected.type==='library'){
      const newDest=destEditInput.value.trim();
      res=await apiFetch(`/api/libraries/${encodeURIComponent(selected.filename)}/entries/${encodeURIComponent(selected.entry.name)}`,{
        method:'PUT', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({template:newContent.trim(),destination:newDest})
      });
    } else {
      res=await apiFetch(`/api/scripts/${encodeURIComponent(selected.name)}`,{
        method:'PUT', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({content:newContent})
      });
    }
    if(!res.ok){ const d=await res.json().catch(()=>({})); throw new Error(d.detail||`Error ${res.status}`); }
    selected.entry.template=newContent;
    selected.entry.params=extractParams(newContent);
    if(selected.type==='library') selected.entry.destination=destEditInput.value.trim();
    if(selected.type==='script') await saveScriptArgPresets(selected.name);
    exitEditMode(false);
    editBtn.classList.remove('is-hidden');
    if(selected.type==='script') renderArgPresetDropdown();
    if(selected.type==='library'){ await loadLibraries(); renderFavoritesSection(); }
  }catch(e){ editError.textContent=e.message; editError.classList.add('visible'); }
  finally{ editSaveBtn.disabled=false; }
});

function buildInlineParams(entry){
  paramsWrap.innerHTML='';
  if(entry.params.length===0){
    const msg=document.createElement('span'); msg.className='no-params-msg'; msg.textContent='no parameters';
    paramsWrap.appendChild(msg);
    execBtn.disabled=false; interactiveBtn.disabled=false; bgBtn.disabled=false;
    return;
  }
  const globals=getGlobalVars();
  entry.params.forEach(p=>{
    const val=globals[p]||'';
    const sp=smartParams[p];
    if(sp){
      paramsWrap.appendChild(buildSmartCombo(p,val,sp));
    } else {
      const wrap=document.createElement('div');
      wrap.className='inline-param';
      const keySpan=document.createElement('span'); keySpan.className='inline-param-key'; keySpan.textContent=p;
      const inp=document.createElement('input');
      inp.className='inline-param-input'+(val?' prefilled':'');
      inp.id='iparam-'+p; inp.type='text'; inp.value=val; inp.placeholder=p;
      inp.dataset.key=p; inp.autocomplete='off'; inp.spellcheck=false;
      wrap.append(keySpan,inp);
      paramsWrap.appendChild(wrap);
    }
  });
  paramsWrap.querySelectorAll('.inline-param-input:not([data-smart])').forEach(inp=>{
    inp.addEventListener('input',()=>{
      inp.classList.toggle('prefilled',!!inp.value.trim());
      inp.classList.remove('missing');
      refreshPreviewCmd(); updateExecBtn();
    });
  });
  updateExecBtn();
}

function _buildSmartComboWrap(paramName, inputId, inputClass, initVal, sp, onChangeCb){
  const comboWrap=document.createElement('div');
  comboWrap.className='smart-combo-wrap'+(sp.type==='script'?' has-refresh':'');

  const input=document.createElement('input');
  input.className=inputClass+(initVal?' prefilled':'');
  if(inputId) input.id=inputId;
  input.type='text';
  input.value=initVal;
  input.placeholder=paramName;
  input.dataset.key=paramName;
  input.dataset.smart='true';
  input.autocomplete='off';
  input.spellcheck=false;
  input.addEventListener('input',()=>{
    input.classList.toggle('prefilled',!!input.value.trim());
    input.classList.remove('missing');
    onChangeCb(input.value);
  });
  comboWrap.appendChild(input);

  const arrBtn=document.createElement('button');
  arrBtn.className='smart-arr-btn';
  arrBtn.type='button';
  arrBtn.title='Options';
  arrBtn.textContent='▾';
  comboWrap.appendChild(arrBtn);

  const dropdown=document.createElement('div');
  dropdown.className='smart-dropdown';
  dropdown.dataset.param=paramName;
  comboWrap.appendChild(dropdown);

  if(sp.type==='script'){
    const refBtn=document.createElement('button');
    refBtn.className='smart-ref-btn';
    refBtn.type='button';
    refBtn.title='Refresh options';
    refBtn.textContent='↺';
    refBtn.addEventListener('click',async e=>{
      e.stopPropagation();
      refBtn.disabled=true; refBtn.classList.add('spinning');
      await fetchSmartParam(paramName);
      refBtn.classList.remove('spinning'); refBtn.disabled=false;
      if(dropdown.classList.contains('open')) populateSmartDropdown(dropdown,paramName,input);
    });
    comboWrap.appendChild(refBtn);
  }

  arrBtn.addEventListener('click',e=>{
    e.stopPropagation();
    const wasOpen=dropdown.classList.contains('open');
    document.querySelectorAll('.smart-dropdown.open').forEach(d=>d.classList.remove('open'));
    if(!wasOpen){ populateSmartDropdown(dropdown,paramName,input); dropdown.classList.add('open'); }
  });

  return comboWrap;
}

function buildSmartCombo(paramName,initVal,sp){
  const wrap=document.createElement('div');
  wrap.className='inline-param';
  const keySpan=document.createElement('span');
  keySpan.className='inline-param-key';
  keySpan.textContent=paramName;
  wrap.appendChild(keySpan);
  wrap.appendChild(_buildSmartComboWrap(paramName,'iparam-'+paramName,'inline-param-input',initVal,sp,
    ()=>{ refreshPreviewCmd(); updateExecBtn(); }
  ));
  return wrap;
}

function buildSmartComboForGvar(key,val,sp){
  return _buildSmartComboWrap(key,'gvar-'+key,'var-input',val,sp,
    ()=>{ refreshPreviewCmd(); renderSessionDropdown(); }
  );
}

/* ── Global Vars (dynamic) ── */
const GVAR_PLACEHOLDER={KVNR:'A123456789',TENANT:'tenant1',ENV:'prod'};

function renderGlobalVarsFixed(){
  const container=document.getElementById('global-vars-fixed');
  if(!container) return;
  const saved={};
  GLOBAL_VAR_KEYS.forEach(k=>{ const el=document.getElementById('gvar-'+k); if(el) saved[k]=el.value; });
  container.innerHTML='';
  GLOBAL_VAR_KEYS.forEach(k=>{
    const val=saved[k]||'';
    const sp=smartParams[k];
    const row=document.createElement('div');
    row.className='var-row';
    const keySpan=document.createElement('span');
    keySpan.className='var-key';
    keySpan.textContent=k;
    row.appendChild(keySpan);
    if(sp){
      row.appendChild(buildSmartComboForGvar(k,val,sp));
    } else {
      const inp=document.createElement('input');
      inp.className='var-input'; inp.id='gvar-'+k;
      inp.placeholder=GVAR_PLACEHOLDER[k]||k;
      inp.spellcheck=false; inp.autocomplete='off'; inp.value=val;
      inp.addEventListener('input',()=>{ refreshPreviewCmd(); renderSessionDropdown(); });
      row.appendChild(inp);
    }
    container.appendChild(row);
  });
}

function populateSmartDropdown(dropdown,paramName,input){
  const sp=smartParams[paramName];
  const opts=sp?.options||[];
  dropdown.innerHTML='';
  if(sp?.loading){
    const d=document.createElement('div'); d.className='smart-opt-empty'; d.textContent='loading…';
    dropdown.appendChild(d); return;
  }
  if(!opts.length){
    const d=document.createElement('div'); d.className='smart-opt-empty';
    d.textContent=sp?.type==='script'?'click ↺ to fetch':'no options';
    dropdown.appendChild(d); return;
  }
  const cur=input.value;
  opts.forEach(opt=>{
    const d=document.createElement('div');
    d.className='smart-opt'+(opt===cur?' smart-sel':'');
    d.textContent=opt;
    d.addEventListener('mousedown',e=>e.preventDefault());
    d.addEventListener('click',()=>{
      input.value=opt;
      input.classList.add('prefilled'); input.classList.remove('missing');
      dropdown.classList.remove('open');
      refreshPreviewCmd(); updateExecBtn();
    });
    dropdown.appendChild(d);
  });
}

function updateExecBtn(){
  if(!selected) return;
  const paramsMissing=selected.entry.params.some(p=>!getInlineParam(p));
  execBtn.disabled=paramsMissing||running;
  interactiveBtn.disabled=paramsMissing||running;
  bgBtn.disabled=paramsMissing||running;
}

function getInlineParam(key){
  return (document.getElementById('iparam-'+key)?.value||'').trim();
}

function getCurrentInlineParams(){
  const p={}; if(!selected) return p;
  selected.entry.params.forEach(k=>{ p[k]=getInlineParam(k); });
  return p;
}

/* ── Live Preview ── */
function resolveTemplate(template,params){
  let s=template;
  for(const [k,v] of Object.entries(params)) s=s.split(`{{${k}}}`).join(v);
  return s;
}

function getResolvedArgs(){
  if(!scriptArgsInput) return '';
  const raw=scriptArgsInput.value.trim();
  if(!raw) return '';
  const params={...getGlobalVars(), ...getCurrentInlineParams()};
  return resolveTemplate(raw, params);
}

async function loadScriptArgPresets(scriptName){
  scriptArgPresets=[];
  try{
    const res=await apiFetch(`/api/scripts/${encodeURIComponent(scriptName)}/arglist`);
    if(res.ok){ const d=await res.json(); scriptArgPresets=d.args||[]; }
  }catch(e){ console.error('loadScriptArgPresets:', e); }
  renderArgPresetDropdown();
}

function renderArgPresetDropdown(){
  argsPresetDropdown.innerHTML='';
  argsPresetBtn.classList.toggle('has-presets', scriptArgPresets.length>0);
  scriptArgPresets.forEach(preset=>{
    const opt=document.createElement('div');
    opt.className='args-preset-opt'; opt.textContent=preset;
    opt.addEventListener('mousedown',e=>{ e.preventDefault(); scriptArgsInput.value=preset; refreshPreviewCmd(); argsPresetDropdown.classList.remove('open'); });
    argsPresetDropdown.appendChild(opt);
  });
}

argsPresetBtn.addEventListener('click',e=>{
  e.stopPropagation();
  argsPresetDropdown.classList.toggle('open');
});
document.addEventListener('click',e=>{
  if(!e.target.closest('.args-combo-wrap')) argsPresetDropdown.classList.remove('open');
});

function renderEditArgsList(){
  editArgsList.innerHTML='';
  [...scriptArgPresets].forEach((preset,i)=>{
    const row=document.createElement('div'); row.className='arg-preset-row';
    const inp=document.createElement('input');
    inp.className='arg-preset-input'; inp.value=preset; inp.spellcheck=false;
    inp.autocomplete='off';
    const del=document.createElement('button');
    del.className='arg-preset-del'; del.textContent='✕';
    del.addEventListener('click',()=>{
      scriptArgPresets=[...[...editArgsList.querySelectorAll('.arg-preset-input')].map(x=>x.value)];
      scriptArgPresets.splice(i,1);
      renderEditArgsList();
    });
    row.appendChild(inp); row.appendChild(del);
    editArgsList.appendChild(row);
  });
}

addArgPresetBtn.addEventListener('click',()=>{
  scriptArgPresets.push('');
  renderEditArgsList();
  editArgsList.querySelector('.arg-preset-row:last-child .arg-preset-input')?.focus();
});

async function saveScriptArgPresets(scriptName){
  const inputs=[...editArgsList.querySelectorAll('.arg-preset-input')];
  const args=inputs.map(inp=>inp.value.trim()).filter(Boolean);
  scriptArgPresets=args;
  try{
    await apiFetch(`/api/scripts/${encodeURIComponent(scriptName)}/arglist`,{
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({args})
    });
  }catch(e){ console.error('arglist save failed', e); }
}

function refreshPreviewCmd(){
  if(!selected) return;
  const params=getCurrentInlineParams();
  previewCmd.innerHTML=renderTemplateHtml(selected.entry.template,params);
  if(selected.type==='library'&&selected.entry.destination&&!editMode){
    destView.innerHTML=renderTemplateHtml(selected.entry.destination,params);
  }
  if(selected.type==='script'&&execCmdCode){
    const resolvedArgs=getResolvedArgs();
    execCmdCode.textContent='';
    const bash=document.createElement('span'); bash.className='cmd-bash'; bash.textContent='bash';
    const scr=document.createElement('span'); scr.className='cmd-script'; scr.textContent=selected.name;
    execCmdCode.append(bash,' ',scr);
    if(resolvedArgs) execCmdCode.append(' '+resolvedArgs);
  }
}

function renderTemplateHtml(template,params){
  return template.split(/(\{\{[A-Z_0-9]+\}\})/g).map(part=>{
    const m=part.match(/^\{\{([A-Z_0-9]+)\}\}$/);
    if(m){
      const val=params[m[1]];
      return val?`<span class="t-val">${esc(val)}</span>`:`<span class="t-miss">${esc(part)}</span>`;
    }
    return esc(part);
  }).join('');
}

/* ── Execute ── */
execBtn.addEventListener('click',()=>{
  if(!selected||running||execBtn.disabled) return;
  const params=getCurrentInlineParams();
  let ok=true;
  selected.entry.params.forEach(p=>{
    if(!params[p]){ const el=document.getElementById('iparam-'+p); if(el) el.classList.add('missing'); ok=false; }
  });
  if(!ok) return;
  if(selected.type==='script'){
    const{name,itemEl}=selected;
    const args=getResolvedArgs();
    runScriptWithParams(name,itemEl,params,args);
  } else {
    execLibraryEntry(selected.filename,selected.entry.name,params,selected.entry);
  }
});

interactiveBtn.addEventListener('click',()=>{
  if(!selected||running||interactiveBtn.disabled) return;
  const params=getCurrentInlineParams();
  let ok=true;
  selected.entry.params.forEach(p=>{
    if(!params[p]){ const el=document.getElementById('iparam-'+p); if(el) el.classList.add('missing'); ok=false; }
  });
  if(!ok) return;
  if(selected.type==='script'){
    const{name,itemEl}=selected;
    const args=getResolvedArgs();
    runScriptInteractive(name,itemEl,params,args);
  } else {
    execLibraryInteractive(selected.filename,selected.entry.name,params,selected.entry);
  }
});

/* ── Run ── */
function sidParam(){ return activeSessionId?`&session_id=${encodeURIComponent(activeSessionId)}`:''; }

function runScript(name,itemEl){
  setActive(itemEl,'script'); setRunning(true);
  setTermTitle('script',name,null);
  hideActionPanel(); clearOutput(); appendPromptLine(null,name);
  const proto=location.protocol==='https:'?'wss:':'ws:';
  activeWs=new WebSocket(`${proto}//${location.host}/ws/run/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}${sidParam()}`);
  wireWs(activeWs);
}

function runScriptWithParams(name,itemEl,params,args=''){
  setActive(itemEl,'script'); setRunning(true);
  clearOutput(); appendPromptLine(null,name);
  const pe=Object.entries(params);
  if(pe.length) appendLine('$ '+pe.map(([k,v])=>k+'='+v).join(' ')+'\n','meta');
  if(args) appendLine('$ args: '+args+'\n','meta');
  const proto=location.protocol==='https:'?'wss:':'ws:';
  activeWs=new WebSocket(`${proto}//${location.host}/ws/run-with-params/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}${sidParam()}`);
  activeWs.addEventListener('open',()=>activeWs.send(JSON.stringify({params,args})));
  wireWs(activeWs);
}

function execLibraryDirect(filename,entry){
  if(entry.params.length===0){ execLibraryEntry(filename,entry.name,{},entry); return; }
  const globals=getGlobalVars(); const params={}; let allFilled=true;
  entry.params.forEach(p=>{ params[p]=globals[p]||''; if(!params[p]) allFilled=false; });
  if(allFilled) execLibraryEntry(filename,entry.name,params,entry);
  else selectLibraryEntry(filename,libraries[filename]?.category||'',entry);
}

function execLibraryEntry(filename,entryName,params,entryHint){
  const cat=libraries[filename]?.category||'';
  const entry=entryHint||libraries[filename]?.entries.find(e=>e.name===entryName)||{};
  const resolvedDest=resolveTemplate(entry.destination||'',params);
  const resolvedCmd=resolveTemplate(entry.template||'',params);
  setRunning(true);
  setTermTitle('library',entryName,cat);
  if(resolvedDest){
    const dw=document.createElement('span'); dw.className='title-dest';
    const dv=document.createElement('span'); dv.className='title-dest-val'; dv.textContent=resolvedDest;
    dw.append('→ ',dv); terminalTitle.append(' ',dw);
  }
  clearOutput(); appendPromptLine(cat,entryName,'main',resolvedDest);
  if(resolvedCmd) appendLine('$ '+resolvedCmd+'\n','meta');
  const proto=location.protocol==='https:'?'wss:':'ws:';
  activeWs=new WebSocket(`${proto}//${location.host}/ws/exec?token=${encodeURIComponent(token)}${sidParam()}`);
  activeWs.addEventListener('open',()=>activeWs.send(JSON.stringify({library:filename,name:entryName,params})));
  wireWs(activeWs);
}

function runScriptInteractive(name,itemEl,params,args=''){
  setActive(itemEl,'script');
  const tabId=openInteractiveTab(name);
  appendPromptLine(null,name,tabId);
  const pe=Object.entries(params);
  if(pe.length) appendLine('$ '+pe.map(([k,v])=>k+'='+v).join(' ')+'\n','meta',tabId);
  if(args) appendLine('$ args: '+args+'\n','meta',tabId);
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(`${proto}//${location.host}/ws/run-interactive/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}${sidParam()}`);
  ws.addEventListener('open',()=>ws.send(JSON.stringify({params,args})));
  wireWs(ws,tabId);
}

function execLibraryInteractive(filename,entryName,params,entryHint){
  const cat=libraries[filename]?.category||'';
  const entry=entryHint||libraries[filename]?.entries.find(e=>e.name===entryName)||{};
  const resolvedDest=resolveTemplate(entry.destination||'',params);
  const resolvedCmd=resolveTemplate(entry.template||'',params);
  const title=(cat?cat+' / ':'')+entryName+(resolvedDest?' → '+resolvedDest:'');
  const tabId=openInteractiveTab(title);
  appendPromptLine(cat,entryName,tabId,resolvedDest);
  if(resolvedCmd) appendLine('$ '+resolvedCmd+'\n','meta',tabId);
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(`${proto}//${location.host}/ws/exec-interactive?token=${encodeURIComponent(token)}${sidParam()}`);
  ws.addEventListener('open',()=>ws.send(JSON.stringify({library:filename,name:entryName,params})));
  wireWs(ws,tabId);
}

function sendInteractiveInput(){
  const val=interactiveInput.value; if(!val) return;
  const tab=tabs.get(activeTabId); if(!tab||!tab.ws) return;
  tab.ws.send(JSON.stringify({type:'input',data:val+'\n'}));
  interactiveInput.value='';
}

interactiveSendBtn.addEventListener('click',sendInteractiveInput);
interactiveInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'){ e.preventDefault(); sendInteractiveInput(); }
  if(e.ctrlKey&&e.key==='c'){ e.preventDefault(); const t=tabs.get(activeTabId); if(t?.ws) t.ws.send(JSON.stringify({type:'input',data:'\x03'})); }
  if(e.ctrlKey&&e.key==='d'){ e.preventDefault(); const t=tabs.get(activeTabId); if(t?.ws) t.ws.send(JSON.stringify({type:'input',data:'\x04'})); }
});
interactiveCloseBtn.addEventListener('click',()=>{
  const tab=tabs.get(activeTabId);
  if(tab?.ws){ tab.ws.send(JSON.stringify({type:'close'})); setTimeout(()=>{ if(tab.ws) tab.ws.close(); },300); }
});

function wireWs(ws,tabId='main'){
  const tab=tabs.get(tabId);
  if(tab) tab.ws=ws;

  if(tab?.xterm){
    const xterm=tab.xterm;
    xterm.onData(data=>{
      if(ws.readyState===WebSocket.OPEN)
        ws.send(JSON.stringify({type:'input',data}));
    });
    xterm.onResize(({cols,rows})=>{
      if(ws.readyState===WebSocket.OPEN)
        ws.send(JSON.stringify({type:'resize',cols,rows}));
    });
    ws.addEventListener('message',e=>{
      let msg; try{msg=JSON.parse(e.data);}catch{return;}
      if(msg.type==='stdout'||msg.type==='stderr') xterm.write(msg.data);
      else if(msg.type==='exit') handleExit(parseInt(msg.data,10),tabId);
      else if(msg.type==='error'){xterm.write('\x1b[31m[error] '+msg.data+'\x1b[0m\r\n');handleExit(-1,tabId);}
    });
    ws.addEventListener('error',()=>{xterm.write('\x1b[31m[websocket error]\x1b[0m\r\n');handleExit(-1,tabId);});
    ws.addEventListener('close',()=>{ const t=tabs.get(tabId); if(t&&t.running) handleExit(-1,tabId); });
    return;
  }

  if(tabId!=='main'&&tabId===activeTabId){
    interactiveBar.classList.add('visible');
    setTimeout(()=>interactiveInput.focus(),80);
  }
  ws.addEventListener('message',e=>{
    let msg; try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='stdout')      appendLine(msg.data,'stdout',tabId);
    else if(msg.type==='stderr') appendLine(msg.data,'stderr',tabId);
    else if(msg.type==='exit')   handleExit(parseInt(msg.data,10),tabId);
    else if(msg.type==='error')  {appendLine('[error] '+msg.data,'stderr',tabId); handleExit(-1,tabId);}
  });
  ws.addEventListener('error',()=>{appendLine('[websocket error]','stderr',tabId); handleExit(-1,tabId);});
  ws.addEventListener('close',()=>{ const t=tabs.get(tabId); if(t&&t.running) handleExit(-1,tabId); });
}

function handleExit(code,tabId='main'){
  const tab=tabs.get(tabId);
  if(tabId!=='main'&&(!tab||!tab.running)) return;
  if(tab){ tab.running=false; tab.ws=null; }
  if(tab?.xterm){
    tab.xterm.write('\r\n\x1b[2m[process exited with code '+code+']\x1b[0m\r\n');
    if(tabId===activeTabId) killBtn.classList.remove('visible');
    renderTabBar();
    return;
  }
  appendLine('\n[process exited with code '+code+']','meta',tabId);
  if(tabId==='main'){
    setRunning(false);
    interactiveBar.classList.remove('visible');
    interactiveInput.value='';
    exitBadge.textContent='EXIT '+code; exitBadge.className=code===0?'ok':'err';
    activeWs=null;
  } else {
    if(tabId===activeTabId){
      interactiveBar.classList.remove('visible');
      interactiveInput.value='';
      killBtn.classList.remove('visible');
    }
    renderTabBar();
  }
}

/* ── ANSI ── */
const _A16=['#282a36','#ff5555','#50fa7b','#f1fa8c','#bd93f9','#ff79c6','#8be9fd','#f8f8f2','#6272a4','#ff6e6e','#69ff94','#ffffa5','#d6acff','#ff92df','#a4ffff','#ffffff'];
function _a256(n){if(n<16)return _A16[n];if(n>=232){const v=8+(n-232)*10;return`rgb(${v},${v},${v})`;}n-=16;const b=n%6,g=Math.floor(n/6)%6,r=Math.floor(n/36),c=v=>v?55+v*40:0;return`rgb(${c(r)},${c(g)},${c(b)})`;}
function newAnsiState(){return{fg:null,bg:null,bold:false,under:false,buf:''};}
function _sgr(codes,s){
  let i=0;while(i<codes.length){const n=codes[i];
  if(n===0){s.fg=null;s.bg=null;s.bold=false;s.under=false;}
  else if(n===1)s.bold=true;else if(n===4)s.under=true;
  else if(n===22)s.bold=false;else if(n===24)s.under=false;
  else if(n>=30&&n<=37)s.fg=_A16[n-30];
  else if(n===38){if(codes[i+1]===5&&codes[i+2]!=null){s.fg=_a256(codes[i+2]);i+=2;}else if(codes[i+1]===2&&codes[i+4]!=null){s.fg=`rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`;i+=4;}}
  else if(n===39)s.fg=null;
  else if(n>=40&&n<=47)s.bg=_A16[n-40];
  else if(n===48){if(codes[i+1]===5&&codes[i+2]!=null){s.bg=_a256(codes[i+2]);i+=2;}else if(codes[i+1]===2&&codes[i+4]!=null){s.bg=`rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]})`;i+=4;}}
  else if(n===49)s.bg=null;
  else if(n>=90&&n<=97)s.fg=_A16[n-82];
  else if(n>=100&&n<=107)s.bg=_A16[n-92];
  i++;}
}
function ansiToHtml(text,state){
  text=state.buf+text; state.buf='';
  text=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const li=text.lastIndexOf('\x1b');
  if(li!==-1){const tail=text.slice(li);if(tail.length<32&&!/\x1b\[[0-9;?]*[A-Za-z]/.test(tail)){state.buf=tail;text=text.slice(0,li);}}
  const E=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const sty=s=>{let c='';if(s.fg)c+=`color:${s.fg};`;if(s.bg)c+=`background:${s.bg};`;if(s.bold)c+='font-weight:700;';if(s.under)c+='text-decoration:underline;';return c;};
  let html='',last=0;
  const re=/\x1b\[([0-9;?]*)([A-Za-z])/g; let m;
  while((m=re.exec(text))!==null){
    const b=text.slice(last,m.index);
    if(b){const c=sty(state);html+=c?`<span style="${c}">${E(b)}</span>`:E(b);}
    last=m.index+m[0].length;
    if(m[2]==='m') _sgr(m[1]?m[1].split(';').map(Number):[0],state);
  }
  const t=text.slice(last);
  if(t){const c=sty(state);html+=c?`<span style="${c}">${E(t)}</span>`:E(t);}
  return html;
}

/* ── Output ── */
function clearOutput(tabId='main'){
  const tab=tabs.get(tabId); if(!tab) return;
  tab.outputEl.innerHTML='';
  if(tab.ansiState) tab.ansiState=newAnsiState();
  if(tabId==='main'){ exitBadge.className=''; exitBadge.textContent=''; emptyState.classList.add('is-hidden'); }
}
function appendPromptLine(cat,name,tabId='main',destination=''){
  const tab=tabs.get(tabId); if(!tab) return;
  if(tab.xterm){
    const catPart=cat?'\x1b[36m'+cat+'\x1b[0m / ':'';
    const destPart=destination?' \x1b[2m→ '+destination+'\x1b[0m':'';
    tab.xterm.write('\x1b[1;32m❯\x1b[0m '+catPart+name+destPart+'\r\n');
    return;
  }
  if(tabId==='main') emptyState.classList.add('is-hidden');
  const div=document.createElement('div'); div.className='prompt-line';
  const arrow=document.createElement('span'); arrow.className='prompt-arrow'; arrow.textContent='❯';
  div.appendChild(arrow);
  if(cat){ const cs=document.createElement('span'); cs.className='prompt-cat'; cs.textContent=cat; div.append(cs,' / '); }
  const ns=document.createElement('span'); ns.textContent=name; div.appendChild(ns);
  if(destination){ const ds=document.createElement('span'); ds.className='prompt-dest'; ds.textContent='→ '+destination; div.append(' ',ds); }
  tab.outputEl.appendChild(div);
}
function appendLine(text,type,tabId='main'){
  const tab=tabs.get(tabId); if(!tab) return;
  if(tab.xterm){
    if(type==='meta') tab.xterm.write('\x1b[2m'+text.replace(/\n/g,'\r\n')+'\x1b[0m');
    else tab.xterm.write(text);
    return;
  }
  if(tabId==='main') emptyState.classList.add('is-hidden');
  const span=document.createElement('span'); span.className='line-'+type;
  if((type==='stdout'||type==='stderr')&&tab.ansiState) span.innerHTML=ansiToHtml(text,tab.ansiState);
  else span.textContent=text;
  tab.outputEl.appendChild(span);
  if(tabId===activeTabId) outputWrap.scrollTop=outputWrap.scrollHeight;
}

killBtn.addEventListener('click',()=>{
  if(activeTabId==='main'){
    if(activeWs) activeWs.close();
  } else {
    const tab=tabs.get(activeTabId); if(!tab) return;
    const ws=tab.ws;
    if(ws){ try{ws.send(JSON.stringify({type:'close'}));}catch(e){} setTimeout(()=>{ try{ws.close();}catch(e){} },300); }
    handleExit(-1,activeTabId);
  }
});

clearBtn.addEventListener('click',()=>{
  if(activeTabId==='main'){
    output.innerHTML=''; exitBadge.className=''; exitBadge.textContent='';
    emptyState.classList.remove('is-hidden');
    if(!running){
      terminalTitle.textContent=''; const _cs=document.createElement('span'); _cs.textContent='SELECT A SCRIPT'; terminalTitle.appendChild(_cs);
      hideActionPanel();
      document.querySelectorAll('.script-item').forEach(el=>el.classList.remove('active'));
    }
  } else {
    const tab=tabs.get(activeTabId);
    if(tab?.xterm) tab.xterm.clear();
    else if(tab) tab.outputEl.innerHTML='';
  }
});

/* ── Status ── */
function setActive(itemEl,type){
  document.querySelectorAll('.script-item').forEach(el=>el.classList.remove('active'));
  if(type==='script'&&itemEl) itemEl.classList.add('active');
}

function setRunning(state){
  running=state;
  const _mt=tabs.get('main'); if(_mt) _mt.running=state;
  spinner.classList.toggle('visible',state);
  statusDot.className='status-dot '+(state?'running':'idle');
  statusText.textContent=state?'RUNNING':'IDLE';
  document.querySelectorAll('.script-item,.lib-item').forEach(el=>el.classList.toggle('disabled',state));
  document.querySelectorAll('.inline-param-input,.inline-param-key').forEach(el=>{
    if(state) el.classList.add('disabled'); else el.classList.remove('disabled');
    if(el.tagName==='INPUT') el.disabled=state;
  });
  if(state){ execBtn.disabled=true; interactiveBtn.disabled=true; bgBtn.disabled=true; } else updateExecBtn();
  editBtn.disabled=state;
  killBtn.classList.toggle('visible',state);
}

/* ── Create Modal ── */
(function(){
  let createMode='script', createLibFilename='';
  const modal   =document.getElementById('create-modal');
  const titleEl =document.getElementById('create-title');
  const libRow  =document.getElementById('create-lib-row');
  const nameInp =document.getElementById('create-name-input');
  const destRow =document.getElementById('create-dest-row');
  const destInp =document.getElementById('create-dest-input');
  const contentA=document.getElementById('create-content-area');
  const labelEl =document.getElementById('create-content-label');
  const errEl   =document.getElementById('create-modal-error');
  const saveBtn =document.getElementById('create-save-btn');

  window.openCreateModal=function(mode,libFilename,libCategory){
    createMode=mode; createLibFilename=libFilename||'';
    nameInp.value=''; contentA.value=''; destInp.value=''; errEl.classList.remove('visible'); errEl.textContent='';
    if(mode==='script'){
      titleEl.textContent='NEW SCRIPT'; libRow.classList.add('is-hidden'); destRow.classList.add('is-hidden');
      labelEl.textContent='CONTENT';
      contentA.placeholder='#!/bin/bash\necho Hello';
      contentA.value='#!/bin/bash\n';
      nameInp.placeholder='my_script';
    } else {
      titleEl.textContent='NEW ENTRY IN '+(libCategory||'LIBRARY');
      libRow.classList.add('is-hidden'); destRow.classList.remove('is-hidden');
      labelEl.textContent='COMMAND TEMPLATE';
      contentA.placeholder='curl -s https://example.com/{{ENV}}';
      contentA.value='';
      nameInp.placeholder='Entry name';
    }
    modal.classList.add('visible');
    setTimeout(()=>nameInp.focus(),40);
  };

  function close(){ modal.classList.remove('visible'); }
  document.getElementById('create-close-btn').addEventListener('click',close);
  document.getElementById('create-cancel-btn').addEventListener('click',close);
  modal.addEventListener('click',e=>{ if(e.target===modal) close(); });

  saveBtn.addEventListener('click',async()=>{
    const name=nameInp.value.trim();
    const content=contentA.value;
    if(!name){ errEl.textContent='Name required.'; errEl.classList.add('visible'); nameInp.focus(); return; }
    saveBtn.disabled=true; errEl.classList.remove('visible');
    try{
      if(createMode==='script'){
        const res=await apiFetch('/api/scripts',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name,content})
        });
        if(!res.ok){ const d=await res.json().catch(()=>({})); throw new Error(d.detail||`Error ${res.status}`); }
        close();
        const r2=await apiFetch('/api/scripts');
        if(r2.ok) renderScripts(await r2.json());
      } else {
        const res=await apiFetch(`/api/libraries/${encodeURIComponent(createLibFilename)}/entries`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name,destination:destInp.value.trim(),template:content})
        });
        if(!res.ok){ const d=await res.json().catch(()=>({})); throw new Error(d.detail||`Error ${res.status}`); }
        close();
        await loadLibraries();
        renderFavoritesSection();
      }
    }catch(e){ errEl.textContent=e.message; errEl.classList.add('visible'); }
    finally{ saveBtn.disabled=false; }
  });

  contentA.addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') saveBtn.click(); });
})();

/* ── Sidebar Resize ── */
(function(){
  const sidebarEl=document.getElementById('sidebar');
  const handle=document.getElementById('sidebar-resize');
  const MIN=160,MAX=560;
  const saved=parseInt(localStorage.getItem('sidebar_width')||'260',10);
  sidebarEl.style.width=saved+'px';
  handle.addEventListener('mousedown',e=>{
    e.preventDefault();
    handle.classList.add('dragging');
    const startX=e.clientX, startW=sidebarEl.offsetWidth;
    function onMove(e){
      const w=Math.min(MAX,Math.max(MIN,startW+e.clientX-startX));
      sidebarEl.style.width=w+'px';
    }
    function onUp(){
      handle.classList.remove('dragging');
      localStorage.setItem('sidebar_width',sidebarEl.offsetWidth);
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
    }
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
  });
})();

/* ── Filter ── */
(function(){
  const filterInput=document.getElementById('filter-input');
  const filterClear=document.getElementById('filter-clear');
  const filterResults=document.getElementById('filter-results');
  const filterSections=[
    document.getElementById('favorites-section'),
    document.getElementById('scripts-section'),
    document.getElementById('library-sections'),
  ];

  function hideCategories(){ filterSections.forEach(el=>{ if(el) el.classList.add('is-hidden'); }); }
  function showCategories(){ filterSections.forEach(el=>{ if(el) el.classList.remove('is-hidden'); }); }

  function applyFilter(){
    const q=filterInput.value.trim().toLowerCase();
    filterClear.classList.toggle('visible',!!q);
    if(!q){
      filterResults.classList.add('is-hidden');
      filterResults.innerHTML='';
      showCategories();
      return;
    }
    hideCategories();
    filterResults.classList.remove('is-hidden');
    renderFilterResults(q);
  }

  window.renderFilterResults=function(q){
    filterResults.innerHTML='';
    let any=false;

    const ms=_lastScripts.filter(n=>n.toLowerCase().includes(q));
    if(ms.length){
      const lbl=document.createElement('div'); lbl.className='filter-label'; lbl.textContent='Scripts';
      filterResults.appendChild(lbl);
      ms.forEach(name=>{
        const el=buildScriptItemEl(name,{
          favd:isFavScript(name),
          onFav:()=>toggleFavScript(name),
          onRun:()=>{ if(!running) runScript(name,el); },
          onPrev:()=>{ if(!running) selectScript(name,el); },
          onClick:()=>{ if(!running) selectScript(name,el); }
        });
        filterResults.appendChild(el);
      });
      any=true;
    }

    for(const[filename,lib] of Object.entries(libraries)){
      const me=lib.entries.filter(e=>e.name.toLowerCase().includes(q)||lib.category.toLowerCase().includes(q));
      if(!me.length) continue;
      const lbl=document.createElement('div'); lbl.className='filter-label';
      lbl.textContent=lib.category;
      filterResults.appendChild(lbl);
      me.forEach(entry=>{
        const el=buildLibItemEl(entry.name,{
          favd:isFavLib(filename,entry.name),
          onFav:()=>toggleFavLib(filename,entry.name),
          onRun:()=>{ if(!running) execLibraryDirect(filename,entry); },
          onPrev:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); },
          onClick:()=>{ if(!running) selectLibraryEntry(filename,lib.category,entry); }
        });
        filterResults.appendChild(el);
      });
      any=true;
    }

    if(!any){
      const msg=document.createElement('div');
      msg.className='filter-label';
      msg.style.cssText='padding:12px 13px;font-style:italic';
      msg.textContent='no matches';
      filterResults.appendChild(msg);
    }
  };

  window.refreshFilter=function(){
    const q=filterInput.value.trim().toLowerCase();
    if(q) renderFilterResults(q);
  };

  filterInput.addEventListener('input',applyFilter);
  filterClear.addEventListener('click',()=>{ filterInput.value=''; applyFilter(); filterInput.focus(); });
})();

/* ── Command Palette ── */
(function(){
  const modal=document.getElementById('palette-modal');
  const inp=document.getElementById('palette-input');
  const results=document.getElementById('palette-results');
  let selIdx=0, filtered=[];

  function score(q,s){
    s=s.toLowerCase(); q=q.toLowerCase();
    if(!q) return 1;
    if(s===q) return 1000;
    if(s.includes(q)) return 500+(s.startsWith(q)?100:0);
    let qi=0,consec=0,sc=0;
    for(let i=0;i<s.length&&qi<q.length;i++){
      if(s[i]===q[qi]){consec++;sc+=consec*10;if(i===0||' _-/'.includes(s[i-1]))sc+=15;qi++;}
      else consec=0;
    }
    return qi===q.length?sc:0;
  }

  function highlight(str,q){
    if(!q) return esc(str);
    const sl=str.toLowerCase(),ql=q.toLowerCase(),i=sl.indexOf(ql);
    if(i!==-1) return esc(str.slice(0,i))+'<mark>'+esc(str.slice(i,i+ql.length))+'</mark>'+esc(str.slice(i+ql.length));
    let out='',qi=0;
    for(let i=0;i<str.length;i++){
      if(qi<ql.length&&str[i].toLowerCase()===ql[qi]){out+='<mark>'+esc(str[i])+'</mark>';qi++;}
      else out+=esc(str[i]);
    }
    return out;
  }

  function build(){
    const q=inp.value.trim();
    const all=[];
    _lastScripts.forEach(name=>{
      const display=name.replace(/\.sh$/,'');
      const sc=score(q,display);
      if(!q||sc>0) all.push({type:'script',name,display,score:sc});
    });
    for(const[filename,lib]of Object.entries(libraries)){
      lib.entries.forEach(entry=>{
        const sc=Math.max(score(q,entry.name),score(q,lib.category)*0.6);
        if(!q||sc>0) all.push({type:'library',name:entry.name,display:entry.name,cat:lib.category,filename,entry,score:sc});
      });
    }
    if(q) all.sort((a,b)=>b.score-a.score);
    filtered=all.slice(0,14); selIdx=0; render(q);
  }

  function render(q){
    results.innerHTML='';
    if(!filtered.length){results.innerHTML='<div class="pal-empty">no matches</div>';return;}
    filtered.forEach((item,i)=>{
      const el=document.createElement('div');
      el.className='pal-item'+(item.type==='library'?' pal-lib':'')+(i===0?' sel':'');
      /* highlight() wraps matched chars in <mark> — all user values pass through esc() */
      el.innerHTML=`
        <span class="pal-icon">${item.type==='script'?'#!':'◈'}</span>
        <span class="pal-name">${highlight(item.display,q)}</span>
        ${item.cat?`<span class="pal-cat">${esc(item.cat)}</span>`:''}
        <span class="pal-run-hint">⇧↵ run</span>`;
      el.addEventListener('click',e=>{e.shiftKey?doRun(item):doSelect(item);close();});
      results.appendChild(el);
    });
  }

  function setSel(n){
    const els=results.querySelectorAll('.pal-item'); if(!els.length) return;
    els[selIdx]?.classList.remove('sel');
    selIdx=Math.max(0,Math.min(n,els.length-1));
    els[selIdx].classList.add('sel');
    els[selIdx].scrollIntoView({block:'nearest'});
  }

  function doSelect(item){
    if(item.type==='script') selectScript(item.name,null);
    else selectLibraryEntry(item.filename,item.cat,item.entry);
  }

  function doRun(item){
    if(running) return;
    if(item.type==='script') runScript(item.name,null);
    else execLibraryDirect(item.filename,item.entry);
  }

  function open(){ modal.classList.add('visible'); inp.value=''; build(); inp.focus(); }
  function close(){ modal.classList.remove('visible'); }

  inp.addEventListener('input',build);
  inp.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(e.key==='ArrowDown'){e.preventDefault();setSel(selIdx+1);return;}
    if(e.key==='ArrowUp'){e.preventDefault();setSel(selIdx-1);return;}
    if(e.key==='Enter'){
      e.preventDefault();
      const item=filtered[selIdx]; if(!item) return;
      e.shiftKey?doRun(item):doSelect(item); close();
    }
  });
  modal.addEventListener('click',e=>{if(e.target===modal)close();});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key==='k'){
      e.preventDefault();
      modal.classList.contains('visible')?close():open();
    }
  });
})();

/* ── Background Jobs ── */
function renderJobs(jobs){
  bgList.innerHTML='';
  if(!jobs.length){ bgList.innerHTML='<span class="no-jobs-msg">no active jobs</span>'; return; }
  jobs.forEach(job=>{
    const item=document.createElement('div'); item.className='job-item';
    const jdot=document.createElement('span'); jdot.className='job-dot';
    const jname=document.createElement('span'); jname.className='job-name'; jname.title=job.cat?job.cat+' / ':''; jname.textContent=job.name;
    const jtime=document.createElement('span'); jtime.className='job-time'; jtime.textContent=job.started;
    const jstop=document.createElement('button'); jstop.className='job-stop-btn'; jstop.title='Stop job'; jstop.setAttribute('aria-label','Stop '+job.name); jstop.textContent='■';
    item.append(jdot,jname,jtime,jstop);
    jstop.addEventListener('click',()=>stopJob(job.id));
    bgList.appendChild(item);
  });
}

async function refreshJobs(){
  if(!token) return;
  try{
    const res=await apiFetch('/api/jobs');
    if(res.ok) renderJobs(await res.json());
  }catch(e){ console.error('refreshJobs:', e); }
}

async function stopJob(id){
  if(!token) return;
  try{
    await apiFetch(`/api/jobs/${encodeURIComponent(id)}`,{method:'DELETE'});
    refreshJobs();
  }catch(e){ console.error('stopJob:', e); }
}

function startBgPoll(){
  if(bgPollTimer) clearInterval(bgPollTimer);
  bgPollTimer=setInterval(refreshJobs,30000);
}

bgBtn.addEventListener('click',async()=>{
  if(!selected||bgBtn.disabled) return;
  const params=getCurrentInlineParams();
  let ok=true;
  selected.entry.params.forEach(p=>{
    if(!params[p]){ const el=document.getElementById('iparam-'+p); if(el) el.classList.add('missing'); ok=false; }
  });
  if(!ok) return;
  const body=selected.type==='script'
    ?{type:'script',name:selected.name,params,args:getResolvedArgs()}
    :{type:'library',library:selected.filename,name:selected.entry.name,params};
  try{
    const res=await apiFetch('/api/jobs',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    });
    if(!res.ok){ const d=await res.json().catch(()=>({})); throw new Error(d.detail||'Error'); }
    await refreshJobs();
    const orig=bgBtn.textContent;
    bgBtn.textContent='✓ STARTED';
    setTimeout(()=>{ bgBtn.textContent=orig; },1200);
  }catch(e){ console.error('bg job error:', e); }
});

/* ── Tabs ── */
function renderTabBar(){
  tabBar.innerHTML='';
  tabs.forEach(tab=>{
    const el=document.createElement('div');
    el.className='tab'+(tab.type==='interactive'?' itab':tab.type==='file'?' ftab':'')+(tab.id===activeTabId?' active':'');
    if(tab.type==='interactive'&&tab.running){ const ld=document.createElement('span'); ld.className='tab-live-dot'; el.appendChild(ld); }
    const ts=document.createElement('span'); ts.textContent=tab.title; el.appendChild(ts);
    if(tab.id!=='main'){ const cb=document.createElement('button'); cb.className='tab-close-btn'; cb.title='Close tab'; cb.setAttribute('aria-label','Close '+tab.title); cb.textContent='×'; el.appendChild(cb); }
    el.addEventListener('click',e=>{
      if(e.target.closest('.tab-close-btn')){ closeTab(tab.id); return; }
      switchTab(tab.id);
    });
    tabBar.appendChild(el);
  });
}

function switchTab(id){
  const tab=tabs.get(id); if(!tab) return;
  tabs.forEach(t=>t.contentEl.classList.remove('active'));
  tab.contentEl.classList.add('active');
  activeTabId=id;
  renderTabBar();
  if(id==='main'){
    killBtn.classList.toggle('visible',running);
    interactiveBar.classList.remove('visible');
  } else {
    killBtn.classList.toggle('visible',!!tab.running);
    interactiveBar.classList.remove('visible');
    if(tab.xterm){
      setTimeout(()=>{ tab.fitAddon?.fit(); tab.xterm?.focus(); },50);
    }
  }
}

function openInteractiveTab(title){
  tabCounter++;
  const id='itab-'+tabCounter;
  const contentEl=document.createElement('div');
  contentEl.className='tab-content xterm-tab';
  const xtermDiv=document.createElement('div');
  xtermDiv.className='xterm-container';
  contentEl.appendChild(xtermDiv);
  outputWrap.appendChild(contentEl);

  const xterm=new Terminal({
    fontFamily:"'JetBrains Mono','Cascadia Code','Fira Code',monospace",
    fontSize:13,
    lineHeight:1.4,
    cursorBlink:true,
    allowProposedApi:true,
    theme:{
      background:'#0a0e13',foreground:'#c8daea',cursor:'#3dff8f',
      selectionBackground:'rgba(36,51,72,0.7)',
      black:'#0a0e13',red:'#ff4d6a',green:'#3dff8f',yellow:'#ffd166',
      blue:'#38bdf8',magenta:'#ff79c6',cyan:'#8be9fd',white:'#c8daea',
      brightBlack:'#3a5068',brightRed:'#ff6e6e',brightGreen:'#69ff94',
      brightYellow:'#ffffa5',brightBlue:'#a4ffff',brightMagenta:'#ff92df',
      brightCyan:'#a4ffff',brightWhite:'#ffffff',
    },
  });
  const fitAddon=new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(xtermDiv);
  fitAddon.fit();
  xtermDiv.addEventListener('click',()=>xterm.focus());

  const tab={id,title,type:'interactive',ws:null,running:true,contentEl,outputEl:xtermDiv,xterm,fitAddon,ansiState:null};
  tabs.set(id,tab);

  const ro=new ResizeObserver(()=>fitAddon.fit());
  ro.observe(xtermDiv);
  tab.resizeObserver=ro;

  switchTab(id);
  return id;
}

function closeTab(id){
  if(id==='main') return;
  const tab=tabs.get(id); if(!tab) return;
  if(tab.ws){ tab.ws.send(JSON.stringify({type:'close'})); setTimeout(()=>{ if(tab.ws) tab.ws.close(); },300); }
  tab.resizeObserver?.disconnect();
  tab.xterm?.dispose();
  tab.contentEl.remove();
  tabs.delete(id);
  if(activeTabId===id) switchTab('main');
  else renderTabBar();
}

/* ── Smart Params ── */
async function loadSmartParams(){
  if(!token) return;
  try{
    const res=await apiFetch('/api/smart-params');
    if(!res.ok) return;
    smartParams=await res.json();
    renderGlobalVarsFixed();
    renderCustomVars();
    if(selected) buildInlineParams(selected.entry);
    for(const [name,sp] of Object.entries(smartParams)){
      if(sp.type==='script'&&!sp.fetched) fetchSmartParam(name);
    }
  }catch(e){ console.error('loadSmartParams:', e); }
}

async function fetchSmartParam(name){
  if(!smartParams[name]) smartParams[name]={type:'script',options:[],fetched:false};
  smartParams[name].loading=true;
  try{
    const res=await apiFetch(`/api/smart-params/${encodeURIComponent(name)}/refresh`,{method:'POST'});
    if(!res.ok) return;
    const data=await res.json();
    smartParams[name].options=data.options;
    smartParams[name].fetched=true;
  }catch(e){ console.error('fetchSmartParam:', e); }
  finally{
    smartParams[name].loading=false;
    _updateSmartDropdowns(name);
  }
}

function _updateSmartDropdowns(name){
  document.querySelectorAll(`.smart-dropdown[data-param="${CSS.escape(name)}"].open`).forEach(dd=>{
    const input=dd.closest('.smart-combo-wrap')?.querySelector('input');
    if(input) populateSmartDropdown(dd,name,input);
  });
}

document.addEventListener('click',()=>{
  document.querySelectorAll('.smart-dropdown.open').forEach(d=>d.classList.remove('open'));
});

/* ── Workspaces ── */
async function loadWorkspaces(){
  if(!token) return;
  try{
    const res=await apiFetch('/api/workspaces');
    if(!res.ok) return;
    workspaces=await res.json();
    const cur=await apiFetch('/api/workspace');
    if(cur.ok){ const d=await cur.json(); activeWorkspaceId=d.id||'default'; }
    renderWsBar();
  }catch(e){ console.error('loadWorkspaces:', e); }
}

function renderWsBar(){
  const ws=workspaces.find(w=>w.id===activeWorkspaceId);
  wsNameEl.textContent=ws?(ws.name||ws.id).toUpperCase():activeWorkspaceId.toUpperCase();
  workspaceBar.classList.add('loaded');
  wsBtn.disabled=workspaces.length<=1;
}

function populateWsDropdown(){
  wsDropdown.innerHTML='';
  workspaces.forEach(ws=>{
    const d=document.createElement('div');
    d.className='ws-opt'+(ws.id===activeWorkspaceId?' ws-active':'');
    const wdot=document.createElement('span'); wdot.className='ws-dot';
    const wnm=document.createElement('span'); wnm.className='ws-opt-name'; wnm.textContent=ws.name||ws.id;
    d.append(wdot,wnm);
    d.addEventListener('mousedown',e=>e.preventDefault());
    d.addEventListener('click',()=>switchWorkspace(ws.id));
    wsDropdown.appendChild(d);
  });
}

wsBtn.addEventListener('click',()=>{
  if(wsBtn.disabled) return;
  populateWsDropdown();
  wsDropdown.classList.toggle('open');
});

document.addEventListener('click',e=>{
  if(!e.target.closest('#ws-wrap')) wsDropdown.classList.remove('open');
});

async function switchWorkspace(id){
  wsDropdown.classList.remove('open');
  if(id===activeWorkspaceId) return;
  const prev=wsNameEl.textContent;
  wsNameEl.textContent='...';
  wsBtn.disabled=true;
  try{
    const res=await apiFetch('/api/workspace',{
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id})
    });
    if(!res.ok){ wsNameEl.textContent=prev; wsBtn.disabled=workspaces.length<=1; return; }
    const data=await res.json();
    activeWorkspaceId=data.id;
    renderWsBar();
    selected=null; hideActionPanel();
    terminalTitle.textContent=''; const _sw=document.createElement('span'); _sw.textContent='SELECT A SCRIPT'; terminalTitle.appendChild(_sw);
    const fi=document.getElementById('filter-input'); if(fi) fi.value=''; if(window.refreshFilter) refreshFilter();
    sessions={}; setActiveSession(''); renderSessionDropdown();
    localStorage.removeItem('last_session_id');
    GLOBAL_VAR_KEYS.forEach(k=>{ const el=document.getElementById('gvar-'+k); if(el) el.value=''; });
    customVars=[]; renderCustomVars(); refreshPreviewCmd();
    smartParams={};
    await loadSmartParams();
    await loadScripts();
    await loadLibraries();
    renderFavoritesSection();
    await loadSessions();
    await loadStatus();
  }catch(e){ console.error('switchWorkspace:', e); wsNameEl.textContent=prev; wsBtn.disabled=workspaces.length<=1; }
}

/* ── Status ── */
let statusNames = [];
let statusValues = {};
let statusRefreshTimer = null;

const statusList      = document.getElementById('status-list');
const statusReloadBtn = document.getElementById('status-reload-btn');

function renderStatusSection(){
  statusList.innerHTML='';
  statusNames.forEach(name=>{
    const val=statusValues[name];
    const na=val===undefined||val===null;
    const loading=val===undefined;
    const row=document.createElement('div'); row.className='var-row';
    const sk=document.createElement('span'); sk.className='var-key'; sk.textContent=name;
    const sv=document.createElement('span'); sv.className='status-val'+(loading?' loading':na?' na':''); sv.textContent=loading?'…':na?'N/A':val;
    row.append(sk,sv);
    statusList.appendChild(row);
  });
}

async function loadStatus(){
  if(!token) return;
  try{
    const res=await apiFetch('/api/status');
    if(!res.ok) return;
    statusNames=await res.json();
    statusValues={};
    renderStatusSection();
    await refreshStatusValues();
  }catch(e){ console.error('loadStatus:', e); }
}

async function refreshStatusValues(){
  if(!token||!statusNames.length) return;
  statusReloadBtn.classList.add('spinning');
  try{
    const res=await apiFetch('/api/status/run');
    if(!res.ok) return;
    const data=await res.json();
    statusNames.forEach(n=>{ statusValues[n]=data[n]??null; });
    renderStatusSection();
  }catch(e){ console.error('refreshStatusValues:', e); }
  finally{ statusReloadBtn.classList.remove('spinning'); }
}

statusReloadBtn.addEventListener('click',e=>{ e.stopPropagation(); refreshStatusValues(); });

function startStatusAutoRefresh(){
  if(statusRefreshTimer) clearInterval(statusRefreshTimer);
  statusRefreshTimer=setInterval(refreshStatusValues, 30000);
}

/* ── Right Panel ── */
let rpOpen = false;
let rpSections = [];
let rpWidth = parseInt(localStorage.getItem('rp_width') || '280', 10);
const rpDirCache = {};
const rpExpanded = new Set();
const rpEl       = document.getElementById('right-panel');
const rpBtn      = document.getElementById('right-panel-btn');
const rpClose    = document.getElementById('rp-close');
const rpScroll   = document.getElementById('rp-scroll');
const rpResizeEl = document.getElementById('rp-resize');

rpEl.style.width = rpWidth + 'px';

rpResizeEl.addEventListener('mousedown', e => {
  e.preventDefault();
  rpResizeEl.classList.add('dragging');
  const startX = e.clientX, startW = rpWidth;
  function onMove(e){
    rpWidth = Math.max(200, Math.min(600, startW + (startX - e.clientX)));
    rpEl.style.width = rpWidth + 'px';
  }
  function onUp(){
    rpResizeEl.classList.remove('dragging');
    localStorage.setItem('rp_width', rpWidth);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

function toggleRightPanel(){
  rpOpen = !rpOpen;
  rpEl.classList.toggle('open', rpOpen);
  rpBtn.classList.toggle('active', rpOpen);
  if(rpOpen && rpSections.length === 0) loadRpConfig();
}
rpBtn.addEventListener('click', toggleRightPanel);
rpClose.addEventListener('click', () => { rpOpen=false; rpEl.classList.remove('open'); rpBtn.classList.remove('active'); });

async function loadRpConfig(){
  if(!token) return;
  try{
    const res = await apiFetch('/api/right-panel');
    if(!res.ok) return;
    const data = await res.json();
    rpSections = data.map((s,i) => ({...s, idx:i, collapsed:false, filter:''}));
    Object.keys(rpDirCache).forEach(k => delete rpDirCache[k]);
    rpExpanded.clear();
    renderRpSections();
  }catch(e){ console.error('loadRpConfig:', e); }
}

function renderRpSections(){
  rpScroll.innerHTML = '';
  rpSections.forEach((sec, i) => {
    if(sec.type !== 'files') return;
    const div = document.createElement('div');
    div.className = 'rp-section' + (sec.collapsed ? ' collapsed' : '');
    div.id = 'rp-sec-' + i;
    const rphdr=document.createElement('div'); rphdr.className='rp-section-header';
    const rpchev=document.createElement('span'); rpchev.className='rp-chevron'; rpchev.textContent='▼';
    const rpsn=document.createElement('span'); rpsn.className='rp-section-name'; rpsn.textContent=sec.label||'FILES';
    const rpcnt=document.createElement('span'); rpcnt.className='rp-section-count'; rpcnt.id='rp-cnt-'+i; rpcnt.textContent='…';
    rphdr.append(rpchev,rpsn,rpcnt);
    const rpbody=document.createElement('div'); rpbody.className='rp-section-body';
    const rpfw=document.createElement('div'); rpfw.className='rp-filter-wrap';
    const fi=document.createElement('input'); fi.className='rp-filter-input'; fi.id='rp-fi-'+i; fi.placeholder='filter…'; fi.autocomplete='off'; fi.spellcheck=false;
    const fc=document.createElement('button'); fc.className='rp-filter-clear'; fc.id='rp-fc-'+i; fc.setAttribute('aria-label','Clear filter'); fc.textContent='×';
    rpfw.append(fi,fc);
    const rpfiles=document.createElement('div'); rpfiles.className='rp-files-container'; rpfiles.id='rp-files-'+i;
    rpbody.append(rpfw,rpfiles);
    div.append(rphdr,rpbody);
    rphdr.addEventListener('click', () => toggleRpSection(i));
    fi.value = sec.filter;
    fi.addEventListener('input', () => {
      sec.filter = fi.value;
      fc.classList.toggle('visible', !!fi.value);
      if(fi.value){
        const c = document.getElementById('rp-files-'+i);
        if(c) c.innerHTML = '<span class="rp-no-files">searching…</span>';
        loadRpDirRecursive(i, '').then(() => {
          if(sec.filter === fi.value) rerenderRpSection(i);
        });
      } else {
        rerenderRpSection(i);
      }
    });
    fc.addEventListener('click', e => {
      e.stopPropagation();
      sec.filter=''; fi.value=''; fc.classList.remove('visible');
      rerenderRpSection(i);
    });
    rpScroll.appendChild(div);
    if(!sec.collapsed) renderRpTree(i, '', document.getElementById('rp-files-'+i), 0);
  });
}

function toggleRpSection(i){
  const sec = rpSections[i]; if(!sec) return;
  sec.collapsed = !sec.collapsed;
  const el = document.getElementById('rp-sec-'+i);
  if(el) el.classList.toggle('collapsed', sec.collapsed);
  if(!sec.collapsed) renderRpTree(i, '', document.getElementById('rp-files-'+i), 0);
}

function rerenderRpSection(i){
  const c = document.getElementById('rp-files-'+i);
  if(!c) return;
  c.innerHTML = '';
  renderRpTree(i, '', c, 0);
}

async function loadRpDir(i, subpath){
  const key = i + ':' + subpath;
  if(rpDirCache[key]) return;
  try{
    const res = await apiFetch(`/api/panel-files?section=${i}&subpath=${encodeURIComponent(subpath)}`);
    rpDirCache[key] = res.ok ? await res.json() : [];
  }catch(e){ console.error('loadRpDir:', e); rpDirCache[key] = []; }
  if(!subpath){
    const cnt = document.getElementById('rp-cnt-'+i);
    if(cnt) cnt.textContent = rpDirCache[key].length;
  }
}

function rpHasMatch(i, subpath, filter){
  const key = i+':'+subpath;
  if(!rpDirCache[key]) return false;
  return rpDirCache[key].some(e =>
    e.type === 'file'
      ? e.name.toLowerCase().includes(filter)
      : rpHasMatch(i, subpath ? subpath+'/'+e.name : e.name, filter)
  );
}

async function loadRpDirRecursive(i, subpath){
  await loadRpDir(i, subpath);
  const entries = rpDirCache[i+':'+subpath] || [];
  await Promise.all(
    entries
      .filter(e => e.type === 'dir')
      .map(e => loadRpDirRecursive(i, subpath ? subpath+'/'+e.name : e.name))
  );
}

function renderRpTree(i, subpath, container, depth){
  const key = i + ':' + subpath;
  if(!rpDirCache[key]){
    container.innerHTML = '<span class="rp-no-files">loading…</span>';
    loadRpDir(i, subpath).then(() => {
      if(!container.isConnected) return;
      container.innerHTML = '';
      renderRpTree(i, subpath, container, depth);
    });
    return;
  }
  const filter = (rpSections[i]?.filter||'').toLowerCase();
  const entries = rpDirCache[key];
  const visible = entries.filter(e =>
    e.type === 'file'
      ? !filter || e.name.toLowerCase().includes(filter)
      : !filter || rpHasMatch(i, subpath ? subpath+'/'+e.name : e.name, filter)
  );
  if(!visible.length){
    const s = document.createElement('span');
    s.className = 'rp-no-files';
    s.textContent = filter ? 'no match' : 'empty';
    container.appendChild(s);
    return;
  }
  visible.forEach(entry => {
    const fullPath = subpath ? subpath+'/'+entry.name : entry.name;
    const row = document.createElement('div');
    if(entry.type === 'dir'){
      const expKey = i+':'+fullPath;
      const isExp = rpExpanded.has(expKey);
      row.className = 'rp-tree-row rp-dir-row';
      row.style.paddingLeft = (depth*14+9)+'px';
      const rc1=document.createElement('span'); rc1.className='rp-tree-chevron'; rc1.textContent=isExp?'▾':'▸';
      const ri1=document.createElement('span'); ri1.className='rp-tree-icon'; ri1.textContent='▣';
      const rn1=document.createElement('span'); rn1.className='rp-tree-name'; rn1.textContent=entry.name;
      row.append(rc1,ri1,rn1);
      row.addEventListener('click', () => toggleRpDir(i, fullPath));
      container.appendChild(row);
      if(isExp){
        const child = document.createElement('div');
        container.appendChild(child);
        renderRpTree(i, fullPath, child, depth+1);
      }
    } else {
      row.className = 'rp-tree-row rp-file-row';
      row.style.paddingLeft = (depth*14+9)+'px';
      const rc2=document.createElement('span'); rc2.className='rp-tree-chevron'; rc2.style.opacity='0'; rc2.textContent='▸';
      const ri2=document.createElement('span'); ri2.className='rp-tree-icon'; ri2.textContent='▤';
      const rn2=document.createElement('span'); rn2.className='rp-tree-name'; rn2.title=fullPath; rn2.textContent=entry.name;
      row.append(rc2,ri2,rn2);
      row.addEventListener('click', () => openFileTab(i, fullPath));
      container.appendChild(row);
    }
  });
}

function toggleRpDir(i, dirPath){
  const expKey = i+':'+dirPath;
  if(rpExpanded.has(expKey)) rpExpanded.delete(expKey);
  else rpExpanded.add(expKey);
  rerenderRpSection(i);
}

async function openFileTab(sectionIdx, filepath){
  const fileKey = sectionIdx+':'+filepath;
  for(const [id,tab] of tabs){
    if(tab.type==='file'&&tab.fileKey===fileKey){ switchTab(id); return; }
  }
  const fname = filepath.split('/').pop();
  tabCounter++;
  const id = 'ftab-'+tabCounter;
  const contentEl = document.createElement('div');
  contentEl.className = 'tab-content file-tab';
  const wrap = document.createElement('div');
  wrap.className = 'file-viewer-wrap';

  const pathBar = document.createElement('div');
  pathBar.className = 'file-viewer-path-bar';
  const pathText = document.createElement('span');
  pathText.className = 'file-viewer-path-text';
  pathText.textContent = filepath;
  const actDiv = document.createElement('div');
  actDiv.className = 'fv-actions';
  const editBtn   = document.createElement('button'); editBtn.className='fv-btn fv-edit-btn';   editBtn.textContent='✎ EDIT';
  const saveBtn   = document.createElement('button'); saveBtn.className='fv-btn fv-save-btn is-hidden';   saveBtn.textContent='✓ SAVE';
  const cancelBtn = document.createElement('button'); cancelBtn.className='fv-btn fv-cancel-btn is-hidden'; cancelBtn.textContent='CANCEL';
  actDiv.append(editBtn, saveBtn, cancelBtn);
  pathBar.append(pathText, actDiv);

  const pre = document.createElement('pre');
  pre.className = 'file-viewer-pre';
  pre.textContent = 'loading…';
  const ta = document.createElement('textarea');
  ta.className = 'file-viewer-textarea is-hidden';
  ta.spellcheck = false;

  wrap.append(pathBar, pre, ta);
  contentEl.appendChild(wrap);
  outputWrap.appendChild(contentEl);

  const tab = {id, title:fname, type:'file', fileKey, sectionIdx, filepath, contentEl, pre, ta, editBtn, saveBtn, cancelBtn};
  tabs.set(id, tab);
  switchTab(id);

  editBtn.addEventListener('click',   () => enterFileEdit(tab));
  cancelBtn.addEventListener('click', () => exitFileEdit(tab, false));
  saveBtn.addEventListener('click',   () => saveFileTab(tab));

  try{
    const res = await apiFetch(`/api/panel-file?section=${sectionIdx}&filepath=${encodeURIComponent(filepath)}`);
    if(!res.ok){ pre.textContent='Error loading file.'; return; }
    pre.textContent = await res.json();
  }catch(e){ pre.textContent='Error: '+e.message; }
}

function enterFileEdit(tab){
  tab.ta.value = tab.pre.textContent;
  tab.pre.classList.add('is-hidden');
  tab.ta.classList.remove('is-hidden');
  tab.editBtn.classList.add('is-hidden');
  tab.saveBtn.classList.remove('is-hidden');
  tab.cancelBtn.classList.remove('is-hidden');
  tab.ta.focus();
}

function exitFileEdit(tab, commit){
  if(commit) tab.pre.textContent = tab.ta.value;
  tab.ta.classList.add('is-hidden');
  tab.pre.classList.remove('is-hidden');
  tab.saveBtn.classList.add('is-hidden');
  tab.cancelBtn.classList.add('is-hidden');
  tab.editBtn.classList.remove('is-hidden');
}

async function saveFileTab(tab){
  const orig = tab.saveBtn.textContent;
  tab.saveBtn.disabled = true;
  tab.saveBtn.textContent = '…';
  try{
    const res = await apiFetch(
      `/api/panel-file?section=${tab.sectionIdx}&filepath=${encodeURIComponent(tab.filepath)}`,
      {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(tab.ta.value)}
    );
    if(res.ok){
      exitFileEdit(tab, true);
      const dir = tab.filepath.includes('/') ? tab.filepath.slice(0, tab.filepath.lastIndexOf('/')) : '';
      delete rpDirCache[tab.sectionIdx+':'+dir];
    } else {
      tab.saveBtn.textContent = '✗ FAIL';
      setTimeout(()=>{ tab.saveBtn.textContent=orig; tab.saveBtn.disabled=false; }, 1800);
      return;
    }
  }catch(e){
    console.error('saveFileTab:', e);
    tab.saveBtn.textContent = '✗ ERR';
    setTimeout(()=>{ tab.saveBtn.textContent=orig; tab.saveBtn.disabled=false; }, 1800);
    return;
  }
  tab.saveBtn.disabled = false;
  tab.saveBtn.textContent = orig;
}

/* ── DOM Helpers ── */
function buildScriptItemEl(name,{favd,onFav,onRun,onPrev,onClick}){
  const el=document.createElement('div');
  el.className='script-item'; el.dataset.name=name;
  const icon=document.createElement('span'); icon.className='item-icon'; icon.textContent='#!';
  const nm=document.createElement('span'); nm.className='item-name'; nm.textContent=name;
  const acts=document.createElement('div'); acts.className='item-actions';
  const favBtn=document.createElement('button');
  favBtn.className='action-btn fav-btn'+(favd?' favd':'');
  favBtn.title=favd?'Unfavorite':'Favorite';
  favBtn.setAttribute('aria-label',(favd?'Unfavorite ':'Favorite ')+name);
  favBtn.textContent='★';
  const runBtn=document.createElement('button');
  runBtn.className='action-btn run-btn'; runBtn.title='Execute';
  runBtn.setAttribute('aria-label','Execute '+name); runBtn.textContent='▶';
  const prevBtn=document.createElement('button');
  prevBtn.className='action-btn prev-btn'; prevBtn.title='Preview & Parameters';
  prevBtn.setAttribute('aria-label','Preview '+name); prevBtn.textContent='⊞';
  acts.append(favBtn,runBtn,prevBtn);
  el.append(icon,nm,acts);
  favBtn.addEventListener('click',e=>{e.stopPropagation();onFav();});
  runBtn.addEventListener('click',e=>{e.stopPropagation();onRun();});
  prevBtn.addEventListener('click',e=>{e.stopPropagation();onPrev();});
  el.addEventListener('click',()=>onClick());
  return el;
}

function buildLibItemEl(displayName,{favd,onFav,onRun,onPrev,onClick}){
  const el=document.createElement('div');
  el.className='lib-item';
  const icon=document.createElement('span'); icon.className='item-icon'; icon.textContent='◈';
  const nm=document.createElement('span'); nm.className='item-name'; nm.textContent=displayName;
  const acts=document.createElement('div'); acts.className='item-actions';
  const favBtn=document.createElement('button');
  favBtn.className='action-btn fav-btn'+(favd?' favd':'');
  favBtn.title=favd?'Unfavorite':'Favorite';
  favBtn.setAttribute('aria-label',(favd?'Unfavorite ':'Favorite ')+displayName);
  favBtn.textContent='★';
  const runBtn=document.createElement('button');
  runBtn.className='action-btn run-btn'; runBtn.title='Execute';
  runBtn.setAttribute('aria-label','Execute '+displayName); runBtn.textContent='▶';
  const prevBtn=document.createElement('button');
  prevBtn.className='action-btn prev-btn'; prevBtn.title='Preview & Parameters';
  prevBtn.setAttribute('aria-label','Preview '+displayName); prevBtn.textContent='⊞';
  acts.append(favBtn,runBtn,prevBtn);
  el.append(icon,nm,acts);
  favBtn.addEventListener('click',e=>{e.stopPropagation();onFav();});
  runBtn.addEventListener('click',e=>{e.stopPropagation();onRun();});
  prevBtn.addEventListener('click',e=>{e.stopPropagation();onPrev();});
  el.addEventListener('click',()=>onClick());
  return el;
}

/* ── Util ── */
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Theme ── */
const THEMES = [
  {id:'matrix',   label:'MATRIX',    dot:'#3dff8f'},
  {id:'dracula',  label:'DRACULA',   dot:'#50fa7b'},
  {id:'nord',     label:'NORD',      dot:'#88c0d0'},
  {id:'monokai',  label:'MONOKAI',   dot:'#a6e22e'},
  {id:'solarized',label:'SOLARIZED', dot:'#2aa198'},
];
let activeTheme = localStorage.getItem('theme') || 'matrix';

function applyTheme(id) {
  activeTheme = id;
  localStorage.setItem('theme', id);
  if (!id || id === 'matrix') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
}

(function initTheme() {
  const btn = document.getElementById('theme-btn');
  const dd  = document.getElementById('theme-dropdown');
  if (!btn || !dd) return;

  dd.addEventListener('click', e => {
    const opt = e.target.closest('.theme-opt');
    if (!opt) return;
    e.stopPropagation();
    applyTheme(opt.dataset.themeId);
    dd.classList.remove('open');
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    dd.innerHTML = THEMES.map(t =>
      `<div class="theme-opt${activeTheme===t.id?' active':''}" data-theme-id="${t.id}">` +
      `<span class="theme-dot" style="background:${t.dot}"></span>${t.label}</div>`
    ).join('');
    const r = btn.getBoundingClientRect();
    dd.style.top    = (r.bottom + 4) + 'px';
    dd.style.left   = r.left + 'px';
    dd.style.bottom = '';
    dd.style.right  = '';
    dd.classList.add('open');
  });

  document.addEventListener('click', () => dd.classList.remove('open'));
}());

applyTheme(activeTheme);

/* ── Init ── */
loadFavorites();
renderGlobalVarsFixed();
tabs.set('main',{id:'main',title:'MAIN',type:'main',ws:null,running:false,contentEl:document.getElementById('tab-main'),outputEl:output,ansiState:newAnsiState()});
renderTabBar();
if(token){ loadScripts(); loadLibraries().then(renderFavoritesSection); loadSessions().then(restoreLastSession); loadStatus().then(startStatusAutoRefresh); refreshJobs(); startBgPoll(); loadWorkspaces(); loadSmartParams(); loadRpConfig(); }
else showTokenModal(false);

})();
