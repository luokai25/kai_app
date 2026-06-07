// KAI thin client — everything on the server. This file just renders + posts.
(function(){
'use strict';

const DEFAULT_SERVER = 'https://hpjvnohzhpkopisfaemz.supabase.co/functions/v1/kai-brain';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwanZub2h6aHBrb3Bpc2ZhZW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDU5NTcsImV4cCI6MjA5NjE4MTk1N30.f_FubOdzFCLejJGvf-1WNzRLhe__hKzoh2IX0NcDhqM';
// Kai's KAI API key — already provisioned, baked in so he doesn't have to enroll
const DEFAULT_KAI_KEY = 'kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt';

// ---- state, persisted to localStorage ----
const $ = id => document.getElementById(id);
let state = JSON.parse(localStorage.getItem('kai_thin') || '{}');
if(!state.server) state.server = DEFAULT_SERVER;
if(!state.kaiKey) state.kaiKey = DEFAULT_KAI_KEY;
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
  if(state.kaiKey) headers['x-kai-key'] = state.kaiKey;
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
let lastPingData = null;
async function checkServer(){
  try{
    if(!state.kaiKey){ setStatus('not connected', false); return false; }
    const d = await api('/ping');
    lastPingData = d;
    const provLabel = d.provider === 'kai_builtin' ? 'KAI AI' : (d.provider || 'no provider');
    const keyOk = d.provider === 'kai_builtin' ? d.has_builtin_ai : (d.has_groq || d.has_hf || d.has_openai || d.has_cerebras || d.has_mistral);
    const learnedStr = d.lessons_learned ? ` · ${d.lessons_learned} lessons` : '';
    setStatus(keyOk ? `${provLabel} · ready${learnedStr}` : `${provLabel} · set a key`, keyOk || true);
    updateBuiltinStatus(d);
    renderModelPicker(d);
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
// Track which messages we've rated this session
const ratedMessages = new Set();

function renderMessages(msgs){
  const c = $('msgs');
  c.innerHTML = msgs.map(m=>{
    const klass = m.role === 'user' ? 'me' : 'kai';
    const body = m.role === 'user' ? esc(m.text) : linkify(m.text);
    const used = (m.meta?.used?.length) ? `<div class="used">used: ${esc(m.meta.used.join(', '))}</div>` : '';
    const imgs = (m.meta?.image_urls?.length) ? `<div class="imgs">${m.meta.image_urls.map(u=>`<img src="${esc(u)}" onclick="window.open('${esc(u)}','_blank')">`).join('')}</div>` : '';
    // Feedback buttons on KAI messages that have a real server ID
    let feedbackRow = '';
    if(m.role === 'kai' && m.id && !m.meta?.error){
      const rated = ratedMessages.has(m.id);
      const fb = m.feedback;
      feedbackRow = `<div class="fb-row" id="fb-${m.id}">
        <button class="fb-btn${fb===1||rated?'':''}" onclick="sendFeedback('${m.id}',1)" title="Good response">👍</button>
        <button class="fb-btn" onclick="sendFeedback('${m.id}',-1)" title="Bad response">👎</button>
        ${fb===1?'<span class="fb-note">noted ✓</span>':fb===-1?'<span class="fb-note" style="color:var(--bad)">learning ✓</span>':''}
      </div>`;
    }
    return `<div class="msg ${klass}">${imgs}${body}${used}${feedbackRow}</div>`;
  }).join('');
  c.scrollTop = c.scrollHeight;
}
async function sendFeedback(messageId, rating){
  if(ratedMessages.has(messageId + rating)) return;
  ratedMessages.add(messageId + rating);
  const row = $('fb-'+messageId);
  if(row) row.innerHTML = `<span class="fb-note" style="color:var(--gold)">saving…</span>`;
  try{
    await api('/feedback', { method:'POST', body:{ message_id: messageId, rating } });
    if(row){
      if(rating === 1) row.innerHTML = `<span class="fb-note" style="color:var(--good)">👍 noted — KAI will do more of this</span>`;
      else row.innerHTML = `<span class="fb-note" style="color:var(--dim)">👎 noted — KAI is learning from this</span>`;
    }
  }catch(e){
    if(row) row.innerHTML = `<span class="fb-note" style="color:var(--bad)">failed</span>`;
  }
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
  if(!text && !pendingImages.filter(p=>p.url).length) return;
  if(!state.kaiKey){ alert('Set your KAI API key first (menu → Setup)'); return; }
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
      'x-kai-key': state.kaiKey,
    };
    const res = await fetch(state.server + '/chat/stream', {
      method: 'POST', headers,
      body: JSON.stringify({ chat_id: currentChatId, text, image_urls: pendingImages.filter(p=>p.url).map(p=>p.url) }),
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
    pendingImages = [];
    renderAttachPreview();
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

// ---- lessons panel ----
async function loadLessons(){
  const list = $('lessonsList');
  const countEl = $('lessonCount');
  if(!list) return;
  list.innerHTML = '<div class="empty" style="padding:16px">loading…</div>';
  try{
    const d = await api('/lessons');
    const lessons = d.lessons || [];
    if(countEl) countEl.textContent = `(${lessons.length})`;
    if(!lessons.length){
      list.innerHTML = '<div class="empty" style="padding:16px;color:var(--dim)">No lessons yet — chat with KAI and give feedback to help him learn.</div>';
      return;
    }
    const sourceLabels = { feedback:'👍/👎 feedback', self_eval:'self-evaluation', insight:'insight', cron:'cron refresh' };
    list.innerHTML = lessons.map(l=>`
      <div class="lesson-card">
        <div class="lc-text">${esc(l.lesson)}</div>
        <div class="lc-meta">
          <span class="lc-badge">${esc(sourceLabels[l.source]||l.source)}</span>
          <div class="lc-imp"><div class="lc-imp-fill" style="width:${Math.round((l.importance||0.5)*100)}%"></div></div>
          <span style="font-size:10px;color:var(--dim)">${Math.round((l.importance||0.5)*100)}%</span>
        </div>
      </div>`).join('');
  }catch(e){
    list.innerHTML = `<div class="empty" style="padding:16px;color:var(--bad)">${esc(e.message)}</div>`;
  }
}
async function runSelfEvalNow(){
  const btn = $('runSelfEval');
  if(btn) btn.textContent = 'running…';
  try{
    const r = await api('/self-eval', { method:'POST' });
    if(btn) btn.textContent = r.ok ? '✓ Done — lessons updated' : '⚠ '+r.error;
    setTimeout(()=>{ if(btn) btn.textContent = '▶ Run self-eval now'; loadLessons(); }, 2000);
  }catch(e){
    if(btn) btn.textContent = '⚠ '+e.message;
    setTimeout(()=>{ if(btn) btn.textContent = '▶ Run self-eval now'; }, 3000);
  }
}
// Add more models here as we wire them. provider must exist in PROVIDERS on the server.
const MODELS = [
  {
    id: 'kai_builtin',
    name: 'Qwen 2.5 7B',
    icon: '✦',
    desc: 'KAI Built-in · Apache 2.0 · free, always connected',
    provider: 'kai_builtin',
    needsKey: false,
  },
  {
    id: 'groq_llama',
    name: 'Llama 3.3 70B',
    icon: '⚡',
    desc: 'Groq · fastest inference · free tier · needs Groq key',
    provider: 'groq',
    needsKey: true,
    keyHint: 'Groq key required (console.groq.com/keys)',
  },
  {
    id: 'hf_llama',
    name: 'Llama 3.3 70B (HF)',
    icon: '🤗',
    desc: 'HuggingFace Providers · free tier · needs HF token',
    provider: 'hf',
    needsKey: true,
    keyHint: 'HF token required (huggingface.co/settings/tokens)',
  },
  {
    id: 'cerebras_llama',
    name: 'Llama 3.3 70B (Cerebras)',
    icon: '🧠',
    desc: 'Cerebras · fast free tier · needs Cerebras key',
    provider: 'cerebras',
    needsKey: true,
    keyHint: 'Cerebras key required (cloud.cerebras.ai)',
  },
];

function renderModelPicker(pingData){
  const dropdown = $('modelDropdown');
  const pill = $('modelPill');
  const pillName = $('modelPillName');
  const currentProvider = pingData?.provider || state.activeProvider || 'kai_builtin';

  // Find current model
  const current = MODELS.find(m => m.provider === currentProvider) || MODELS[0];
  pillName.textContent = current.name;
  // Gold highlight when using built-in connected model
  const builtinOk = currentProvider === 'kai_builtin' && pingData?.has_builtin_ai;
  pill.classList.toggle('active', builtinOk);

  // Render dropdown items
  dropdown.innerHTML = '<div class="md-title">Choose model</div>';
  for(const m of MODELS){
    const isSelected = m.provider === currentProvider;
    const available = !m.needsKey
      || (m.provider === 'kai_builtin' && pingData?.has_builtin_ai)
      || (m.provider === 'groq' && pingData?.has_groq)
      || (m.provider === 'hf' && pingData?.has_hf)
      || (m.provider === 'cerebras' && pingData?.has_cerebras)
      || (m.provider === 'mistral' && pingData?.has_mistral)
      || (m.provider === 'openai' && pingData?.has_openai);
    const connLabel = m.provider === 'kai_builtin' && pingData?.has_builtin_ai
      ? ' <span style="color:var(--good);font-size:10px">● connected</span>' : '';
    const row = document.createElement('div');
    row.className = 'md-item' + (isSelected ? ' selected' : '');
    row.innerHTML = `<span class="mi-icon">${m.icon}</span><div class="mi-info"><div class="mi-name">${esc(m.name)}${available?connLabel:' <span style="font-size:10px;color:var(--dim)">🔒 key needed</span>'}</div><div class="mi-desc">${esc(m.desc)}</div></div>${isSelected?'<span class="mi-check">✓</span>':''}`;
    row.onclick = () => selectModel(m, pingData);
    dropdown.appendChild(row);
  }
}

async function selectModel(model, pingData){
  closeModelPicker();
  if(model.needsKey){
    const has = (model.provider === 'groq' && pingData?.has_groq) ||
                (model.provider === 'hf' && pingData?.has_hf) ||
                (model.provider === 'cerebras' && pingData?.has_cerebras) ||
                (model.provider === 'openai' && pingData?.has_openai);
    if(!has){
      alert(`${model.name} needs a ${model.provider} key.\n\n${model.keyHint||''}\n\nGo to Setup → paste your key there.`);
      return;
    }
  }
  if(model.provider === 'kai_builtin' && !pingData?.has_builtin_ai){
    alert('KAI Built-in AI not activated yet.\nGo to Setup → paste your HF token to activate it.');
    return;
  }
  state.activeProvider = model.provider;
  persist();
  try{
    await api('/set-key', { method:'POST', body:{ provider: model.provider } });
    $('modelPillName').textContent = model.name;
    setStatus('model: ' + model.name, true);
  }catch(e){
    alert('Failed to switch model: ' + e.message);
  }
}

function openModelPicker(){
  $('modelDropdown').classList.add('open');
  $('modelScrim').classList.add('on');
}
function closeModelPicker(){
  $('modelDropdown').classList.remove('open');
  $('modelScrim').classList.remove('on');
}
async function updateBuiltinStatus(pingData){
  const el = $('builtinStatus');
  if(!el) return;
  if(pingData && pingData.has_builtin_ai){
    el.innerHTML = `<span style="color:var(--good)">✦ ${esc(pingData.builtin_model||'Qwen 2.5 7B')} · always connected · free</span>`;
  } else {
    el.innerHTML = '<span style="color:var(--dim)">Built-in AI not configured on server.</span>';
  }
}
// ---- setup panel ----
async function saveKaiKey(){
  const k = $('kaiKeyInput').value.trim();
  if(!k.startsWith('kai_')){ alert('Should start with kai_'); return; }
  state.kaiKey = k;
  persist();
  $('enrollStat').innerHTML = `<span style="color:var(--good)">saving…</span>`;
  await checkServer();
}
async function testKey(){
  if(!state.kaiKey){ alert('Set a key first'); return; }
  $('enrollStat').innerHTML = 'testing…';
  try{
    const r = await api('/ping');
    if(r.ok){
      $('enrollStat').innerHTML = `<span style="color:var(--good)">✓ ${esc(r.device||'connected')} · ${esc(r.provider||'no provider')} · ${r.has_groq?'groq✓':''} ${r.has_hf?'hf✓':''} ${r.has_openai?'openai✓':''}</span>`;
    } else {
      $('enrollStat').innerHTML = `<span style="color:var(--bad)">⚠ ${esc(r.error||'failed')}</span>`;
    }
  }catch(e){
    $('enrollStat').innerHTML = `<span style="color:var(--bad)">⚠ ${esc(e.message)}</span>`;
  }
}
async function saveProviderKey(){
  const key = $('apiKey').value.trim();
  const prov = $('provSel').value;
  if(!key){ alert('paste a key first'); return; }
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  try{
    const body = { provider: prov };
    if(prov === 'groq') body.groq_key = key;
    else if(prov === 'hf') body.hf_key = key;
    else if(prov === 'openai') body.openai_key = key;
    // Pass provider key under the matching column name
    await api('/set-key', { method:'POST', body });
    alert(prov+' key saved ✓');
    $('apiKey').value = '';
    checkServer();
  }catch(e){ alert('failed: '+e.message); }
}
async function testProvider(){
  if(!state.kaiKey){ alert('Set KAI key first'); return; }
  const prov = $('provSel').value;
  const key = $('apiKey').value.trim();
  try{
    const r = await api('/test-provider', { method:'POST', body:{ provider: prov, key: key || undefined } });
    if(r.ok) alert(`✓ ${r.provider} works\nmodel: ${r.model}\nreply: ${r.reply||'(empty)'}`);
    else alert(`✗ ${r.provider} failed:\n${r.error}`);
  }catch(e){ alert('test failed: '+e.message); }
}
// Update provider hint based on selection
function updateProvHint(){
  const sel = $('provSel');
  if(!sel) return;
  const hints = {
    kai_builtin: '★ KAI Built-in — uses Qwen 2.5 7B Instruct (Apache 2.0). Activate once with your HF token above, then no key needed ever.',
    groq: 'Get free Groq key (recommended): console.groq.com/keys — 14,400 req/day free.',
    hf: 'Get free HF token: huggingface.co/settings/tokens — needs Read access.',
    cerebras: 'Get free Cerebras key: cloud.cerebras.ai — generous free tier.',
    mistral: 'Get free Mistral key: console.mistral.ai — free tier on small models.',
  };
  $('provHint').textContent = hints[sel.value] || '';
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



// ===== IMAGES: pick, upload, attach to next message =====
let pendingImages = [];  // [{url, name, localPreview}]

function renderAttachPreview(){
  const wrap = $('attachPreview');
  if(!pendingImages.length){ wrap.classList.remove('on'); wrap.innerHTML=''; return; }
  wrap.classList.add('on');
  wrap.innerHTML = pendingImages.map((p, i)=>`
    <div class="thumb ${p.uploading?'uploading':''}">
      <img src="${p.localPreview}">
      <button class="rm" onclick="window._removeImg(${i})">×</button>
    </div>
  `).join('');
}
window._removeImg = (idx)=>{ pendingImages.splice(idx, 1); renderAttachPreview(); };

async function pickImages(files){
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  if(!files || !files.length) return;
  // Cap at 5 images per turn (Llama 4 Scout's limit)
  const room = 5 - pendingImages.length;
  if(room <= 0){ alert('Max 5 images at a time'); return; }
  const list = Array.from(files).slice(0, room);
  for(const file of list){
    if(!file.type.startsWith('image/')){ continue; }
    if(file.size > 10 * 1024 * 1024){ alert(`${file.name} too large (>10MB)`); continue; }
    const localPreview = URL.createObjectURL(file);
    const entry = { url: null, name: file.name, localPreview, uploading: true };
    pendingImages.push(entry);
    renderAttachPreview();
    // Upload
    try{
      const headers = {
        'Authorization': 'Bearer ' + ANON_KEY,
        'x-kai-key': state.kaiKey,
        'Content-Type': file.type,
        'x-image-name': file.name.replace(/[^a-zA-Z0-9._-]/g,'_'),
      };
      const res = await fetch(state.server + '/upload-image', { method:'POST', headers, body: file });
      const data = await res.json();
      if(!res.ok || !data.url) throw new Error(data.error || 'upload failed');
      entry.url = data.url;
      entry.uploading = false;
      renderAttachPreview();
    }catch(e){
      const idx = pendingImages.indexOf(entry);
      if(idx >= 0) pendingImages.splice(idx, 1);
      renderAttachPreview();
      alert('upload failed: ' + e.message);
    }
  }
}

// ===== VOICE: record audio, send to /chat/voice, play reply =====
let mediaRecorder = null;
let audioChunks = [];
let recordingStream = null;
let isRecording = false;

async function startRecording(){
  if(isRecording) return;
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  try{
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(e){
    alert('Mic permission denied or unavailable: ' + e.message);
    return;
  }
  audioChunks = [];
  // Prefer webm/opus (smaller, faster); fall back to whatever the browser supports
  const mimeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  let mimeType = '';
  for(const t of mimeOptions){
    if(MediaRecorder.isTypeSupported(t)){ mimeType = t; break; }
  }
  mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : {});
  mediaRecorder.ondataavailable = e => { if(e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start();
  isRecording = true;
  $('micBtn').classList.add('recording');
  $('voiceOverlay').classList.add('on');
  $('voStatus').textContent = 'listening…';
}

async function stopRecording(send){
  if(!isRecording || !mediaRecorder) return;
  return new Promise((resolve)=>{
    mediaRecorder.onstop = async ()=>{
      // Stop all tracks to release the mic
      if(recordingStream){ recordingStream.getTracks().forEach(t=>t.stop()); recordingStream = null; }
      $('micBtn').classList.remove('recording');
      isRecording = false;
      if(!send || audioChunks.length === 0){
        $('voiceOverlay').classList.remove('on');
        resolve();
        return;
      }
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      audioChunks = [];
      $('voStatus').textContent = 'transcribing…';
      try{
        await sendVoice(blob);
      }catch(e){
        $('voStatus').textContent = 'error: ' + e.message;
        setTimeout(()=>$('voiceOverlay').classList.remove('on'), 2000);
      }
      resolve();
    };
    mediaRecorder.stop();
  });
}

async function sendVoice(audioBlob){
  // Post raw audio to /chat/voice
  const headers = {
    'Authorization': 'Bearer ' + ANON_KEY,
    'x-kai-key': state.kaiKey,
    'Content-Type': audioBlob.type || 'audio/webm',
  };
  if(currentChatId) headers['x-chat-id'] = currentChatId;

  const res = await fetch(state.server + '/chat/voice', {
    method: 'POST',
    headers,
    body: audioBlob,
  });
  const data = await res.json();
  if(!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));

  currentChatId = data.chat_id;
  $('voStatus').textContent = 'speaking…';

  // Refresh the chat view so user sees what they said + KAI's reply
  await loadCurrentChat();
  await loadChatList();

  // Play the reply
  if(data.audio_url){
    // OpenAI TTS — play the mp3
    const audio = new Audio(data.audio_url);
    audio.onended = ()=>$('voiceOverlay').classList.remove('on');
    audio.onerror = ()=>{ $('voiceOverlay').classList.remove('on'); fallbackTTS(data.reply); };
    try{ await audio.play(); }
    catch(e){ $('voiceOverlay').classList.remove('on'); fallbackTTS(data.reply); }
  } else if(data.reply){
    // Fall back to browser speechSynthesis
    fallbackTTS(data.reply);
  } else {
    $('voiceOverlay').classList.remove('on');
  }
}

function fallbackTTS(text){
  if(!('speechSynthesis' in window)){
    $('voiceOverlay').classList.remove('on');
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  // Pick a decent voice — prefer something male if available
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v=>/male|onyx|deep/i.test(v.name)) || voices.find(v=>v.lang.startsWith('en'));
  if(preferred) u.voice = preferred;
  u.rate = 1.0;
  u.pitch = 0.95;
  u.onend = ()=>$('voiceOverlay').classList.remove('on');
  u.onerror = ()=>$('voiceOverlay').classList.remove('on');
  speechSynthesis.speak(u);
}

function wireMic(){
  const btn = $('micBtn');
  if(!btn) return;
  // Touch (mobile): hold to record, release to send
  let touchActive = false;
  btn.addEventListener('touchstart', e => {
    e.preventDefault();
    touchActive = true;
    startRecording();
  });
  btn.addEventListener('touchend', e => {
    e.preventDefault();
    if(touchActive){ touchActive = false; stopRecording(true); }
  });
  btn.addEventListener('touchcancel', e => {
    if(touchActive){ touchActive = false; stopRecording(false); }
  });
  // Click (desktop testing): toggle
  btn.addEventListener('click', e => {
    if(touchActive) return;  // touch handled it
    if(isRecording) stopRecording(true);
    else startRecording();
  });
  // Tap overlay to cancel
  $('voiceOverlay').addEventListener('click', ()=>{
    if(isRecording) stopRecording(false);
    else $('voiceOverlay').classList.remove('on');
  });
}

async function saveOpenAIKey(){
  const key = $('openaiKey').value.trim();
  if(!key){ alert('paste a key first'); return; }
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  try{
    await api('/set-key', { method:'POST', body:{ openai_key: key } });
    alert('OpenAI key saved ✓');
    $('openaiKey').value = '';
    checkServer();
  }catch(e){ alert('failed: ' + e.message); }
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
    $('kaiKeyInput').value = state.kaiKey || '';
    updateProvHint();
    testKey();
  };
  $('goNotes').onclick = ()=>{ openP('scrimN','panelN'); loadNotes(); };
  $('goLessons').onclick = ()=>{ openP('scrimL','panelL'); loadLessons(); };
  if($('scrimL')) $('scrimL').onclick = ()=>closeP('scrimL','panelL');
  if($('runSelfEval')) $('runSelfEval').onclick = runSelfEvalNow;
  // Default to KAI built-in provider on first launch
  if(!state.activeProvider) state.activeProvider = 'kai_builtin';

  $('modelPill').onclick = () => {
    renderModelPicker(lastPingData);
    openModelPicker();
  };
  $('modelScrim').onclick = closeModelPicker;

  $('saveKaiKey').onclick = saveKaiKey;
  $('testKey').onclick = testKey;
  $('saveKey').onclick = saveProviderKey;
  $('testProv').onclick = testProvider;
  $('provSel').addEventListener('change', updateProvHint);
  $('forgetDev').onclick = ()=>{
    if(!confirm('Forget this device? You can paste your key again to reconnect.')) return;
    delete state.kaiKey; persist(); checkServer();
    alert('forgotten — paste key again to reconnect');
  };
  $('addNote').onclick = addNote;
  $('cClose').onclick = closeAll;
  $('cRefresh').onclick = ()=>{ loadProjects(); renderProj(); };
  if($('saveOpenAIKey')) $('saveOpenAIKey').onclick = saveOpenAIKey;
  wireMic();
  $('imgBtn').onclick = ()=>$('imgPicker').click();
  $('imgPicker').onchange = (e)=>{ pickImages(e.target.files); e.target.value=''; };

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
