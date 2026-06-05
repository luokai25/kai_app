// KAI thin client — everything on the server. This file just renders + posts.
(function(){
'use strict';

const DEFAULT_SERVER = 'https://hpjvnohzhpkopisfaemz.supabase.co/functions/v1/kai-brain';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwanZub2h6aHBrb3Bpc2ZhZW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDU5NTcsImV4cCI6MjA5NjE4MTk1N30.f_FubOdzFCLejJGvf-1WNzRLhe__hKzoh2IX0NcDhqM';

// ---- state, persisted to localStorage ----
const $ = id => document.getElementById(id);
let state = JSON.parse(localStorage.getItem('kai_thin') || '{}');
if(!state.server) state.server = DEFAULT_SERVER;
if(!state.devSecret){
  // generate one
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  state.devSecret = btoa(String.fromCharCode(...a)).replace(/[+/=]/g,'').slice(0,28);
}
function persist(){ localStorage.setItem('kai_thin', JSON.stringify(state)); }
persist();

let currentChatId = null;
let chatsCache = [];

// ---- API helpers ----
async function api(path, opts){
  opts = opts || {};
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + ANON_KEY,
    ...(opts.headers || {})
  };
  if(state.deviceId){ headers['x-device-id'] = state.deviceId; }
  if(state.devSecret){ headers['x-device-secret'] = state.devSecret; }
  const res = await fetch(state.server + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if(!res.ok) throw new Error(data.error || ('HTTP '+res.status));
  return data;
}

// ---- server status ----
async function checkServer(){
  try{
    if(!state.deviceId){ setStatus('not connected', false); return false; }
    const d = await api('/ping');
    setStatus(d.has_key ? `connected · ${d.provider}` : 'connected · no key', true);
    return true;
  }catch(e){
    setStatus('disconnected: '+e.message, false, true);
    return false;
  }
}
function setStatus(text, ok, err){
  const dot = $('srvDot');
  dot.classList.toggle('on', !!ok);
  dot.classList.toggle('err', !!err);
  $('modepill').textContent = text;
}

// ---- render messages ----
function esc(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function linkify(text){
  // Convert URLs to clickable links, with special styling for Supabase artifact URLs
  const escaped = esc(text);
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (url)=>{
    const isArtifact = url.includes('/storage/v1/object/public/kai-artifacts/');
    // pull the filename from end of artifact URL for a nice label
    if(isArtifact){
      const m = url.match(/\d+_([^/]+)$/);
      const fname = m ? m[1] : 'file';
      const ext = (fname.split('.').pop()||'').toLowerCase();
      const icon = ext==='pdf'?'📄':ext==='md'?'📝':ext==='html'?'🌐':ext==='json'?'⚙️':ext==='csv'?'📊':'📎';
      return `<a href="${url}" target="_blank" rel="noopener" class="artifact">${icon} ${esc(fname)}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline">${esc(url.length>50?url.slice(0,47)+'…':url)}</a>`;
  });
}
function renderMessages(msgs){
  const c = $('msgs');
  c.innerHTML = msgs.map(m=>{
    const klass = m.role === 'user' ? 'me' : 'kai';
    const body = m.role === 'user' ? esc(m.text) : linkify(m.text);
    const used = (m.meta?.used?.length) ? `<div class="used">used: ${esc(m.meta.used.join(', '))}</div>` : '';
    return `<div class="msg ${klass}">${body}${used}</div>`;
  }).join('');
  c.scrollTop = c.scrollHeight;
}
async function loadCurrentChat(){
  if(!currentChatId){ $('msgs').innerHTML = '<div class="empty">Tap to start a conversation with KAI.</div>'; return; }
  try{
    const d = await api('/messages?chat_id='+currentChatId);
    renderMessages(d.messages || []);
  }catch(e){ $('msgs').innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`; }
}
async function loadChatList(){
  try{
    const d = await api('/chats');
    chatsCache = d.chats || [];
    $('chatlist').innerHTML = chatsCache.length
      ? chatsCache.map(c=>`<div class="chatitem ${c.id===currentChatId?'active':''}" data-id="${c.id}">${esc(c.title)}</div>`).join('')
      : '<div class="empty">no chats yet</div>';
    document.querySelectorAll('.chatitem').forEach(el=>{
      el.onclick = ()=>{ currentChatId = el.dataset.id; loadCurrentChat(); loadChatList(); closeAll(); };
    });
  }catch(e){ $('chatlist').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ---- send a message ----
async function send(){
  const inp = $('input');
  const text = (inp.value || '').trim();
  if(!text) return;
  if(!state.deviceId){ alert('Connect to KAI server first (menu → Setup)'); return; }
  inp.value = ''; inp.style.height = '44px';
  $('sendBtn').disabled = true;

  // optimistic render
  const localMsgs = [];
  try{
    // load existing messages first
    if(currentChatId){
      const d = await api('/messages?chat_id='+currentChatId);
      (d.messages||[]).forEach(m=>localMsgs.push(m));
    }
  }catch{}
  localMsgs.push({role:'user', text});
  const placeholderIdx = localMsgs.length;
  localMsgs.push({role:'kai', text:'…', _streaming:true});
  renderMessages(localMsgs);

  try{
    // Use streaming endpoint if available, fall back to /chat
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ANON_KEY,
      'x-device-id': state.deviceId,
      'x-device-secret': state.devSecret,
    };
    const res = await fetch(state.server + '/chat/stream', {
      method: 'POST', headers,
      body: JSON.stringify({ chat_id: currentChatId, text }),
    });
    if(!res.ok){
      // fall back to non-streaming
      const errData = await res.json().catch(()=>({}));
      throw new Error(errData.error || ('HTTP '+res.status));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream:true});
      // SSE format: data: {...} (per event)
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for(const ev of events){
        const line = ev.replace(/^data:\s*/, '').trim();
        if(!line) continue;
        try{
          const evt = JSON.parse(line);
          if(evt.type === 'chat_id') currentChatId = evt.chat_id;
          else if(evt.type === 'delta'){
            accumulated += evt.text;
            localMsgs[placeholderIdx] = {role:'kai', text: accumulated, _streaming:true};
            renderMessages(localMsgs);
          }
          else if(evt.type === 'tools'){
            // remember which tools were used to show under final message
            localMsgs[placeholderIdx].meta = {used: evt.used};
          }
          else if(evt.type === 'done'){
            localMsgs[placeholderIdx] = {role:'kai', text: evt.reply, meta:{used: evt.used||[]}};
            renderMessages(localMsgs);
          }
          else if(evt.type === 'error'){
            throw new Error(evt.error || 'stream error');
          }
        }catch(e){
          if(e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
    await loadChatList();
  }catch(e){
    localMsgs[placeholderIdx] = {role:'kai', text:'⚠ '+e.message};
    renderMessages(localMsgs);
  }finally{
    $('sendBtn').disabled = false;
  }
}

// ---- panels ----
function openP(scrim, panel){ closeAll(); $(scrim).classList.add('on'); $(panel).classList.add('on'); }
function closeAll(){
  ['scrimL','panelL','scrimS','panelS','scrimC','panelC','scrimN','panelN'].forEach(id=>$(id)?.classList.remove('on'));
}

// ---- setup panel ----
async function doEnroll(){
  state.server = ($('srvUrl').value || DEFAULT_SERVER).trim();
  persist();
  $('enrollStat').textContent = 'enrolling…';
  try{
    const d = await fetch(state.server + '/enroll', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':'Bearer '+ANON_KEY},
      body: JSON.stringify({ device_name:'phone', device_secret: state.devSecret })
    }).then(r=>r.json());
    if(d.device_id){
      state.deviceId = d.device_id;
      persist();
      $('enrollStat').innerHTML = `<span style="color:var(--good)">✓ connected · device ${d.device_id.slice(0,8)}…</span>`;
      checkServer();
    } else {
      $('enrollStat').innerHTML = `<span style="color:var(--bad)">⚠ ${esc(d.error||'failed')}</span>`;
    }
  }catch(e){
    $('enrollStat').innerHTML = `<span style="color:var(--bad)">⚠ ${esc(e.message)}</span>`;
  }
}
async function saveProviderKey(){
  const key = $('apiKey').value.trim();
  const prov = $('provSel').value;
  if(!key){ alert('paste a key first'); return; }
  if(!state.deviceId){ alert('connect first'); return; }
  try{
    await api('/set-key', { method:'POST', body:{ groq_key: key, groq_provider: prov } });
    alert('saved on server ✓');
    $('apiKey').value = '';
    checkServer();
  }catch(e){ alert('failed: '+e.message); }
}

// ---- KAI Computer panel ----
let projectsCache = [];
let activeProjId = null;
async function loadProjects(){
  try{
    const d = await api('/projects');
    projectsCache = d.projects || [];
    $('projList').innerHTML = projectsCache.length
      ? projectsCache.map(p=>{
          const dotClass = p.status;
          return `<div class="chatitem ${p.id===activeProjId?'active':''}" data-id="${p.id}" style="font-size:13px">
            <span class="proj-dot ${dotClass}"></span>${esc(p.title)}<br>
            <span style="color:var(--dim);font-size:10px">${p.current_step}/${p.plan?.length||0} · ${p.status}</span>
          </div>`;
        }).join('')
      : '<div class="empty">No projects.<br>Ask KAI for multi-step work.</div>';
    document.querySelectorAll('#projList .chatitem').forEach(el=>{
      el.onclick = ()=>{ activeProjId = el.dataset.id; renderProj(); loadProjects(); };
    });
  }catch(e){ $('projList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function renderProj(){
  const p = projectsCache.find(x=>x.id===activeProjId);
  if(!p){ $('projDetail').innerHTML = '<div class="empty">Select a project.</div>'; return; }
  const planHtml = (p.plan||[]).map((s,i)=>{
    const mark = s.status==='done'?'✓':s.status==='error'?'✕':i===p.current_step?'→':'·';
    const color = s.status==='done'?'var(--good)':s.status==='error'?'var(--bad)':i===p.current_step?'var(--gold)':'var(--dim)';
    return `<div style="padding:4px 0;color:${color};font-size:13px"><b>${mark}</b> ${esc(s.step)}${s.result?`<div style="font-size:11px;color:var(--dim);margin-left:18px">→ ${esc(String(s.result).slice(0,200))}</div>`:''}</div>`;
  }).join('') || '<i style="color:var(--dim);font-size:12px">No plan yet.</i>';
  const files = Object.keys(p.files||{});
  const filesHtml = files.length
    ? files.map(f=>`<div style="padding:3px 0;font-family:monospace;font-size:11px"><span style="color:#74c0fc">📄 ${esc(f)}</span> <span style="color:var(--dim)">(${(p.files[f]||'').length} chars)</span></div>`).join('')
    : '<i style="color:var(--dim);font-size:12px">No files.</i>';
  const log = (p.log||[]).slice(-12).map(l=>{
    const tm = new Date(l.t).toLocaleTimeString();
    return `<div class="log-line ${l.type}">[${tm}] ${esc(l.msg)}</div>`;
  }).join('') || '<i style="color:var(--dim);font-size:11px">no activity</i>';
  $('projDetail').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;gap:6px">
      <div>
        <h4 style="margin:0;font-family:var(--font);color:var(--gold)">${esc(p.title)}</h4>
        <div style="font-size:11px;color:var(--dim)">${p.status} · ${p.current_step}/${p.plan?.length||0}</div>
      </div>
      <div>
        ${p.status==='running'?`<button class="tm-btn" onclick="window._stopProj('${p.id}')">⏸</button>`:''}
        <button class="tm-btn danger" onclick="window._delProj('${p.id}')">🗑</button>
      </div>
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--dim)">Goal: ${esc(p.goal||'(none)')}</div>
    <div class="sec" style="padding:8px 0 4px">Plan</div>${planHtml}
    <div class="sec" style="padding:8px 0 4px">Files (${files.length})</div>${filesHtml}
    <div class="sec" style="padding:8px 0 4px">Log</div>
    <div style="background:#000;padding:6px 8px;border-radius:6px;max-height:140px;overflow-y:auto">${log}</div>
  `;
}
window._stopProj = async (id)=>{ try{ await api('/project/'+id+'/stop',{method:'POST'}); loadProjects(); renderProj(); }catch(e){ alert(e.message); } };
window._delProj = async (id)=>{ if(!confirm('Delete project?')) return; try{ await api('/project/'+id,{method:'DELETE'}); activeProjId=null; loadProjects(); renderProj(); }catch(e){ alert(e.message); } };

// ---- notes panel ----
async function loadNotes(){
  try{
    const d = await api('/notes');
    const notes = d.notes || [];
    $('notesList').innerHTML = notes.length
      ? notes.map(n=>`<div style="padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px"><div>${esc(n.fact)}</div><div style="font-size:10px;color:var(--dim);margin-top:3px">${new Date(n.created_at).toLocaleString()}</div></div>`).join('')
      : '<div class="empty">No notes yet. KAI saves things here when you tell him to remember.</div>';
  }catch(e){ $('notesList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function addNote(){
  const fact = prompt('What should KAI remember?');
  if(!fact) return;
  try{ await api('/remember', {method:'POST', body:{fact}}); loadNotes(); }
  catch(e){ alert(e.message); }
}

// ---- boot ----
function init(){
  // wire buttons
  $('openMenu').onclick = ()=>{ openP('scrimL','panelL'); loadChatList(); };
  $('openComputer').onclick = ()=>{ openP('scrimC','panelC'); loadProjects(); renderProj(); };
  $('newChatBtn').onclick = ()=>{ currentChatId = null; loadCurrentChat(); $('input').focus(); };
  $('goSetup').onclick = ()=>{
    openP('scrimS','panelS');
    $('srvUrl').value = state.server;
    $('devSecret').value = state.devSecret;
    $('enrollStat').textContent = state.deviceId ? `connected · device ${state.deviceId.slice(0,8)}…` : 'not connected';
  };
  $('goNotes').onclick = ()=>{ openP('scrimN','panelN'); loadNotes(); };
  $('doEnroll').onclick = doEnroll;
  $('saveKey').onclick = saveProviderKey;
  $('forgetDev').onclick = ()=>{
    if(!confirm('Forget this device? You will need to enroll again, but server data stays.')) return;
    delete state.deviceId; persist(); checkServer();
    alert('forgotten — enroll again when ready');
  };
  $('addNote').onclick = addNote;
  $('cClose').onclick = closeAll;
  $('cRefresh').onclick = ()=>{ loadProjects(); renderProj(); };

  // close panels by scrim
  ['scrimL','scrimS','scrimC','scrimN'].forEach(id=>$(id).onclick = closeAll);

  // composer
  $('sendBtn').onclick = send;
  $('input').addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }
  });
  $('input').addEventListener('input', e=>{
    e.target.style.height='auto';
    e.target.style.height = Math.min(120, e.target.scrollHeight)+'px';
  });

  // first paint
  loadCurrentChat();
  checkServer();

  // poll projects in background every 10s when computer panel open
  setInterval(()=>{
    if($('panelC').classList.contains('on')){ loadProjects(); if(activeProjId) renderProj(); }
  }, 10000);
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
