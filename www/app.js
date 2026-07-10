// KAI — Build T — complete rewrite fixing all runtime bugs
// Defensive init, fixed streaming, fixed model picker, working send
(function(){
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const SERVER   = 'https://hpjvnohzhpkopisfaemz.supabase.co/functions/v1/kai-brain';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwanZub2h6aHBrb3Bpc2ZhZW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDU5NTcsImV4cCI6MjA5NjE4MTk1N30.f_FubOdzFCLejJGvf-1WNzRLhe__hKzoh2IX0NcDhqM';
const KAI_KEY  = 'kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt';
const GH_REPO  = 'luokai25/kai_app';
const BUILD    = 'T';

// ── State ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el=$(id); if(el) el.addEventListener(ev, fn); };
const set = (id, fn) => { const el=$(id); if(el) fn(el); };

let state = {};
try { state = JSON.parse(localStorage.getItem('kai_thin') || '{}'); } catch {}
state.server  = state.server  || SERVER;
state.kaiKey  = state.kaiKey  || KAI_KEY;
state.jarvisEnabled = state.jarvisEnabled !== false;
state.jarvisVolume  = state.jarvisVolume  || 1.0;
state.activeProvider = state.activeProvider || 'or_openrouter_free';
function save(){ try{ localStorage.setItem('kai_thin', JSON.stringify(state)); }catch{} }
save();

let currentChatId  = null;
let lastPingData   = null;
let agentMode      = false;
let pendingImages  = [];
let sessionTokens  = 0;
let streamTokens   = 0;
let isRecording    = false;
let mediaRecorder  = null;
let audioChunks    = [];
let recStream      = null;
let currentAudio   = null;
let hasGreeted     = false;
let localModelId   = null;
let webLLMEngine   = null;

// ── API ───────────────────────────────────────────────────────────────────────
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
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if(!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(text, ok, err){
  set('srvDot', el => {
    el.classList.toggle('on',  !!ok && !err);
    el.classList.toggle('err', !!err);
  });
  set('modepill', el => el.textContent = text);
}

async function checkServer(){
  setStatus('connecting…', false, false);
  try {
    if(!state.kaiKey){ setStatus('no key — go to Setup', false, true); return; }
    const d = await api('/ping');
    lastPingData = d;
    const prov = d.provider === 'kai_builtin' ? 'KAI AI' : (d.provider || 'ready');
    const evol = d.evolution_count ? ` · ${d.evolution_count} evolutions` : '';
    setStatus(prov + ' · ready' + evol, true, false);
    set('builtinStatus', el => el.innerHTML = d.has_builtin_ai
      ? `<span style="color:var(--good)">✦ ${d.builtin_model||'Qwen 2.5 7B'} · connected · free</span>`
      : '<span style="color:var(--dim)">Built-in AI not configured.</span>');
    renderModelPicker(d);
    checkPingForEvolution(d);
  } catch(e) {
    setStatus('disconnected: ' + e.message, false, true);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function md(text){
  return esc(text)
    .replace(/```([\s\S]*?)```/g,'<pre style="background:#000;padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;margin:6px 0"><code>$1</code></pre>')
    .replace(/`([^`]+)`/g,'<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/^#{1,3} (.+)$/gm,'<div style="font-weight:700;color:var(--gold);margin:8px 0 3px">$1</div>')
    .replace(/^[-*] (.+)$/gm,'<div style="padding:1px 0 1px 12px">• $1</div>')
    .replace(/(https?:\/\/[^\s<"&]+)/g, url => {
      const clean = url.replace(/&amp;/g,'&');
      return `<a href="${esc(clean)}" target="_blank" rel="noopener" style="color:var(--gold)">${esc(clean.length>50?clean.slice(0,47)+'…':clean)}</a>`;
    });
}

// ── Message rendering ─────────────────────────────────────────────────────────
const rated = new Set();

function renderMessages(msgs){
  const c = $('msgs');
  if(!c) return;
  if(!msgs || !msgs.length){
    c.innerHTML = '<div class="empty">Say something to KAI.</div>';
    return;
  }
  c.innerHTML = msgs.map(m => {
    const isUser = m.role === 'user';
    const raw = m.text || '';
    const imgUrls = [
      ...(m.meta?.image_urls || []),
      ...(raw.match(/https?:\/\/image\.pollinations\.ai\/[^\s"<>]+/g) || []),
      ...(raw.match(/https?:\/\/hpjvnohzhpkopisfaemz\.supabase\.co\/storage\/v1\/object\/public\/kai-artifacts\/[^\s"<>]+/g) || []),
    ].filter((u,i,a) => a.indexOf(u)===i);
    const vidUrls = (raw.match(/https?:\/\/\S+\.(mp4|webm|mov)(\?\S*)?/gi) || []);
    const cleanText = raw
      .replace(/https?:\/\/image\.pollinations\.ai\/[^\s"<>]+/g,'')
      .replace(/https?:\/\/hpjvnohzhpkopisfaemz\.supabase\.co\/storage\/v1\/object\/public\/kai-artifacts\/[^\s"<>]+/g,'')
      .replace(/https?:\/\/\S+\.(mp4|webm|mov)(\?\S*)?/gi,'')
      .trim();
    const body = isUser
      ? `<div style="white-space:pre-wrap">${esc(cleanText||raw)}</div>`
      : `<div class="kai-body">${md(cleanText||raw)}</div>`;
    const imgs = imgUrls.map(u => `<div class="img-bubble"><img src="${esc(u)}" loading="lazy" onclick="window._expandImg('${esc(u)}')" onerror="this.parentElement.style.display='none'"></div>`).join('');
    const vids = vidUrls.map(u => `<div class="vid-bubble"><video src="${esc(u)}" controls playsinline preload="metadata"></video></div>`).join('');
    const tokens = !isUser && m.meta?.tokens ? `<span class="msg-tok">~${m.meta.tokens>=1000?(m.meta.tokens/1000).toFixed(1)+'k':m.meta.tokens} tok</span>` : '';
    let fb = '';
    if(!isUser && m.id && !m._streaming){
      const v = m.feedback;
      fb = `<div class="fb-row" id="fb-${m.id}">
        <button class="fb-btn" onclick="window._fb('${m.id}',1)">👍</button>
        <button class="fb-btn" onclick="window._fb('${m.id}',-1)">👎</button>
        ${v===1?'<span style="color:var(--good);font-size:11px">noted ✓</span>':v===-1?'<span style="color:var(--bad);font-size:11px">learning ✓</span>':''}
      </div>`;
    }
    return `<div class="msg ${isUser?'me':'kai'}">${imgs}${vids}${body}${tokens}${fb}</div>`;
  }).join('');
  c.scrollTop = c.scrollHeight;
}

window._expandImg = url => {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;flex-direction:column;gap:10px';
  ov.innerHTML = `<img src="${esc(url)}" style="max-width:95%;max-height:85vh;border-radius:10px;object-fit:contain">
    <a href="${esc(url)}" target="_blank" style="color:var(--gold);font-size:13px">Open full size ↗</a>`;
  ov.onclick = e => { if(e.target===ov) ov.remove(); };
  document.body.appendChild(ov);
};

window._fb = async (id, rating) => {
  if(rated.has(id+rating)) return;
  rated.add(id+rating);
  const row = $('fb-'+id);
  if(row) row.innerHTML = '<span style="color:var(--gold);font-size:11px">saving…</span>';
  try {
    await api('/feedback', {method:'POST', body:{message_id:id, rating}});
    if(row) row.innerHTML = rating===1
      ? '<span style="color:var(--good);font-size:11px">👍 KAI will do more of this</span>'
      : '<span style="color:var(--dim);font-size:11px">👎 KAI is learning from this</span>';
  } catch { if(row) row.innerHTML = ''; }
};

// ── Chat loading ──────────────────────────────────────────────────────────────
async function loadCurrentChat(){
  if(!currentChatId){
    const c = $('msgs');
    if(c) c.innerHTML = '<div class="empty">Say something to KAI.</div>';
    return;
  }
  try {
    const d = await api('/messages?chat_id=' + currentChatId);
    renderMessages(d.messages || []);
  } catch(e) {
    const c = $('msgs');
    if(c) c.innerHTML = `<div class="empty">Could not load: ${esc(e.message)}</div>`;
  }
}

async function loadChatList(){
  const el = $('chatlist');
  if(!el) return;
  try {
    const d = await api('/chats');
    const chats = d.chats || [];
    if(!chats.length){ el.innerHTML = '<div class="empty">No chats yet</div>'; return; }
    const sorted = [...chats].sort((a,b) => (b.starred?1:0)-(a.starred?1:0));
    el.innerHTML = sorted.map(c => `
      <div class="chatitem ${c.id===currentChatId?'active':''}" data-id="${c.id}">
        <div class="ci-title">${c.starred?'⭐ ':''}${esc(c.title||'Untitled')}</div>
        <div class="ci-actions">
          <button class="ci-btn" data-star="${c.id}">${c.starred?'★':'☆'}</button>
          <button class="ci-btn del" data-del="${c.id}">🗑</button>
        </div>
      </div>`).join('');
    el.querySelectorAll('.chatitem').forEach(row => {
      row.querySelector('.ci-title').onclick = () => {
        currentChatId = row.dataset.id;
        loadCurrentChat(); loadChatList(); closeAll();
      };
    });
    el.querySelectorAll('[data-star]').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        await api(`/chat/${btn.dataset.star}/star`, {method:'POST'}).catch(()=>{});
        loadChatList();
      };
    });
    el.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        if(!confirm('Delete this chat?')) return;
        await api(`/chat/${btn.dataset.del}`, {method:'DELETE'}).catch(()=>{});
        if(currentChatId === btn.dataset.del){ currentChatId=null; renderMessages([]); }
        loadChatList();
      };
    });
  } catch(e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function newChat(){
  currentChatId = null;
  renderMessages([]);
  closeAll();
  const inp = $('input');
  if(inp) inp.focus();
}

function clearImages(){ pendingImages = []; renderAttachPreview(); }

// ── Send ──────────────────────────────────────────────────────────────────────
async function send(){
  const inp  = $('input');
  const text = (inp ? inp.value : '').trim();
  if(!text && !pendingImages.filter(p=>p.url).length) return;
  if(!state.kaiKey){ alert('Set your KAI key in Setup (menu → Setup & API keys)'); return; }

  if(inp) inp.value = '';
  set('sendBtn', el => el.disabled = true);

  if(text.startsWith('/image ')){ await generateImage(text.slice(7).trim()); set('sendBtn',el=>el.disabled=false); return; }
  if(text.startsWith('/reel ')) { await generateReel(text.slice(6).trim());  set('sendBtn',el=>el.disabled=false); return; }

  // Build local message list for immediate display
  const localMsgs = [];
  if(currentChatId){
    try { const d = await api('/messages?chat_id='+currentChatId); (d.messages||[]).forEach(m=>localMsgs.push(m)); } catch {}
  }
  localMsgs.push({role:'user', text});
  const pidx = localMsgs.length;
  localMsgs.push({role:'kai', text:'…', _streaming:true});
  renderMessages(localMsgs);

  // Local on-device Gemma routing — bypasses network entirely
  if(state.activeProvider === 'local_gemma4e2b'){
    try { await sendLocalGemma(text, localMsgs, pidx); }
    finally { set('sendBtn', el => el.disabled = false); clearImages(); }
    return;
  }

  try {
    // Agentic mode
    if(agentMode){
      localMsgs[pidx] = {role:'kai', text:'🤖 All models thinking…', _streaming:true};
      renderMessages(localMsgs);
      const r = await api('/chat/agentic', {method:'POST', body:{
        chat_id: currentChatId, text,
        image_urls: pendingImages.filter(p=>p.url).map(p=>p.url)
      }});
      if(r.error) throw new Error(r.error);
      if(r.chat_id) currentChatId = r.chat_id;
      addTokens(r.tokens||0);
      localMsgs[pidx] = {role:'kai', text:r.reply, meta:{tokens:r.tokens||0, participants:r.participants}};
      renderMessages(localMsgs);
      clearImages();
      if(state.jarvisEnabled) jarvisSpeak(r.reply);
      await loadChatList();
      return;
    }

    // Streaming chat
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ANON_KEY,
      'x-kai-key': state.kaiKey,
    };
    const res = await fetch(state.server + '/chat/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: currentChatId,
        text,
        image_urls: pendingImages.filter(p=>p.url).map(p=>p.url)
      }),
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || 'HTTP ' + res.status);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', accumulated = '';

    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream:true});
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for(const part of parts){
        const line = part.replace(/^data:\s*/, '').trim();
        if(!line) continue;
        try {
          const evt = JSON.parse(line);
          if(evt.type === 'chat_id'){ currentChatId = evt.chat_id; }
          else if(evt.type === 'delta'){
            accumulated += evt.text;
            streamTokens = Math.round(accumulated.length/4);
            updateTokenDisplay(sessionTokens + streamTokens, true);
            localMsgs[pidx] = {role:'kai', text:accumulated, _streaming:true};
            renderMessages(localMsgs);
          }
          else if(evt.type === 'done'){
            const tok = evt.tokens || streamTokens;
            addTokens(tok); streamTokens = 0;
            localMsgs[pidx] = {role:'kai', text:evt.reply||accumulated, meta:{tokens:tok}};
            renderMessages(localMsgs);
            if(state.jarvisEnabled) jarvisSpeak(evt.reply||accumulated);
          }
          else if(evt.type === 'error'){ throw new Error(evt.error || 'stream error'); }
        } catch(e){ if(e.message && !e.message.includes('JSON')) throw e; }
      }
    }
    clearImages();
    await loadChatList();
  } catch(e){
    localMsgs[pidx] = {role:'kai', text:'⚠ ' + e.message};
    renderMessages(localMsgs);
  } finally {
    set('sendBtn', el => el.disabled = false);
  }
}

// ── Panels ────────────────────────────────────────────────────────────────────
const PANELS = ['scrimL','panelL','scrimS','panelS','scrimC','panelC','scrimN','panelN','scrimK','panelK','scrimX','panelX','scrimE','panelE','scrimG','panelG'];
function closeAll(){ PANELS.forEach(id => $(id)?.classList.remove('on')); }
function openP(scrim, panel){ closeAll(); $(scrim)?.classList.add('on'); $(panel)?.classList.add('on'); }

// ── Model picker ──────────────────────────────────────────────────────────────
const MODELS = [
  {id:'or_openrouter_free', name:'OpenRouter Auto',    icon:'🆓', source:'OpenRouter Free'},
  {id:'or_qwen3_coder',     name:'Qwen3 Coder 480B',  icon:'🔥', source:'OpenRouter Free'},
  {id:'or_nemotron550b',    name:'Nemotron Ultra 550B',icon:'🔥', source:'OpenRouter Free'},
  {id:'or_gptoss120b',      name:'GPT-OSS 120B',       icon:'🔥', source:'OpenRouter Free'},
  {id:'or_llama70b',        name:'Llama 3.3 70B',      icon:'🦙', source:'OpenRouter Free'},
  {id:'or_gemma31b',        name:'Gemma 4 31B',        icon:'💎', source:'OpenRouter Free'},
  {id:'or_kimi',            name:'Kimi K2',             icon:'🌙', source:'OpenRouter Free'},
  {id:'or_qwen80b',         name:'Qwen3 80B',           icon:'🆓', source:'OpenRouter Free'},
  {id:'or_hermes405b',      name:'Hermes 3 405B',       icon:'🔥', source:'OpenRouter Free'},
  {id:'or_llama3b',         name:'Llama 3.2 3B',        icon:'🆓', source:'OpenRouter Free'},
  {id:'or_dolphin',         name:'Dolphin 24B',         icon:'🆓', source:'OpenRouter Free'},
  {id:'or_lfm_think',       name:'LFM2.5 Thinking',    icon:'🆓', source:'OpenRouter Free'},
  {id:'github_gpt4o',       name:'GPT-4o',              icon:'🐙', source:'GitHub Models'},
  {id:'github_gpt4omini',   name:'GPT-4o mini',         icon:'🐙', source:'GitHub Models'},
  {id:'github_llama405b',   name:'Llama 3.1 405B',      icon:'🐙', source:'GitHub Models'},
  {id:'github_llama8b',     name:'Llama 3.1 8B',        icon:'🐙', source:'GitHub Models'},
  {id:'groq',               name:'Llama 70B (Groq)',    icon:'⚡', source:'Groq'},
  {id:'kai_builtin',        name:'Qwen 2.5 7B',         icon:'✦',  source:'HF Inference'},
  {id:'local_gemma4e2b',    name:'Gemma-4-E2B-it (local model)', icon:'📱', source:'On-Device'},
];

function getCurrentModel(){
  return MODELS.find(m => m.id === state.activeProvider) || MODELS[0];
}

function updateModelPill(){
  const m = getCurrentModel();
  set('modelPillName', el => el.textContent = m.name);
  set('modelPillIcon', el => el.textContent = m.icon);
}

function wireQuickChips(){
  document.querySelectorAll('.mq-chip').forEach(chip => {
    chip.classList.toggle('sel', chip.dataset.pid === state.activeProvider);
    chip.onclick = () => selectModel(chip.dataset.pid);
  });
}

function renderModelPicker(pingData){
  const dd = $('modelDropdown');
  if(!dd) return;
  updateModelPill();
  wireQuickChips();

  const grouped = {};
  MODELS.forEach(m => { if(!grouped[m.source]) grouped[m.source]=[]; grouped[m.source].push(m); });
  const order = ['On-Device','OpenRouter Free','GitHub Models','HF Inference','Groq'];

  dd.innerHTML = '<div class="md-handle"></div>';
  order.forEach(src => {
    if(!grouped[src]) return;
    const secEl = document.createElement('div');
    secEl.innerHTML = `<div class="md-source">${src}</div>`;
    grouped[src].forEach(m => {
      const row = document.createElement('div');
      row.className = 'md-item' + (m.id===state.activeProvider?' selected':'');
      row.innerHTML = `<span class="mi-icon">${m.icon}</span>
        <div class="mi-info">
          <div class="mi-name">${esc(m.name)}${m.id===state.activeProvider?' <span style="color:var(--gold)">✓</span>':''}</div>
          <div class="mi-meta" style="font-size:10px;color:var(--dim)">${src}</div>
        </div>`;
      row.onclick = () => selectModel(m.id);
      secEl.appendChild(row);
    });
    dd.appendChild(secEl);
  });
}

async function selectModel(id){
  closeModelPicker();
  const switchingAway = state.activeProvider === 'local_gemma4e2b' && id !== 'local_gemma4e2b';
  state.activeProvider = id;
  save();
  updateModelPill();
  wireQuickChips();
  if(switchingAway) unloadGemmaModel();
  if(id === 'local_gemma4e2b'){
    const m = MODELS.find(x => x.id === id);
    setStatus((m?m.name:'Model') + ' · on-device', true, false);
    return;
  }
  try { await api('/set-key', {method:'POST', body:{provider:id}}); }
  catch(e) { console.warn('set-key failed:', e.message); }
  if(lastPingData){ lastPingData.provider = id; }
  const m = MODELS.find(x => x.id === id);
  setStatus((m?m.name:'Model') + ' · ready', true, false);
}

function openModelPicker(){
  renderModelPicker(lastPingData);
  $('modelDropdown')?.classList.add('open');
  $('modelScrim')?.classList.add('on');
}

function closeModelPicker(){
  $('modelDropdown')?.classList.remove('open');
  $('modelScrim')?.classList.remove('on');
}

function toggleAgentMode(){
  agentMode = !agentMode;
  set('agentBtn', el => {
    el.classList.toggle('on', agentMode);
    el.textContent = agentMode ? '🤖 Agentic' : '🤖';
  });
  setStatus(agentMode ? '🤖 Agentic mode' : 'ready', true, false);
}

// ── Token display ─────────────────────────────────────────────────────────────
function updateTokenDisplay(n, streaming){
  set('tokenPill', el => el.style.display='flex');
  set('tokenCount', el => el.textContent = n>=1000?(n/1000).toFixed(1)+'k':String(n));
  $('tokenPill')?.classList.toggle('streaming', !!streaming);
}
function addTokens(n){ sessionTokens += n; updateTokenDisplay(sessionTokens, false); }

// ── Image generation ──────────────────────────────────────────────────────────
function promptImageGen(){
  const p = prompt('Describe the image:');
  if(p?.trim()) generateImage(p.trim());
}
function promptReelGen(){
  const t = prompt('Reel topic (e.g. "success mindset --type=motivational"):');
  if(t?.trim()) generateReel(t.trim());
}

async function generateImage(prompt){
  const local = currentChatId ? ((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]) : [];
  local.push({role:'user', text:'/image '+prompt});
  local.push({role:'kai', text:'🎨 Generating…', _streaming:true});
  renderMessages(local);
  try {
    const r = await api('/generate-image', {method:'POST', body:{prompt, chat_id:currentChatId}});
    if(r.error) throw new Error(r.error);
    if(r.chat_id) currentChatId = r.chat_id;
    local[local.length-1] = {role:'kai', text:r.url, meta:{image_urls:[r.url]}};
    renderMessages(local);
    if(state.jarvisEnabled) jarvisSpeak('Image generated.');
  } catch(e){
    local[local.length-1] = {role:'kai', text:'❌ Image failed: '+e.message};
    renderMessages(local);
  }
}

async function generateReel(input){
  let topic=input, type='motivational', style='minimal', scenes=5;
  const tm=input.match(/--type=(\S+)/); if(tm){type=tm[1];topic=topic.replace(tm[0],'').trim();}
  const sm=input.match(/--style=(\S+)/); if(sm){style=sm[1];topic=topic.replace(sm[0],'').trim();}
  const nm=input.match(/--scenes=(\d+)/); if(nm){scenes=parseInt(nm[1]);topic=topic.replace(nm[0],'').trim();}
  const local = currentChatId ? ((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]) : [];
  local.push({role:'user', text:`/reel ${input}`});
  local.push({role:'kai', text:'🎬 Creating reel…', _streaming:true});
  renderMessages(local);
  try {
    const r = await api('/generate-reel', {method:'POST', body:{topic,type,style,scenes,chat_id:currentChatId}});
    if(r.error) throw new Error(r.error);
    if(r.chat_id) currentChatId = r.chat_id;
    const reply = `🎬 ${topic}\n\n${r.script_summary||''}\n\n${(r.image_urls||[]).join('\n')}`;
    local[local.length-1] = {role:'kai', text:reply, meta:{image_urls:r.image_urls||[]}};
    renderMessages(local);
  } catch(e){
    local[local.length-1] = {role:'kai', text:'❌ Reel failed: '+e.message};
    renderMessages(local);
  }
}

// ── Image attach ──────────────────────────────────────────────────────────────
function renderAttachPreview(){
  const wrap = $('attachPreview');
  if(!wrap) return;
  if(!pendingImages.length){ wrap.classList.remove('on'); wrap.innerHTML=''; return; }
  wrap.classList.add('on');
  wrap.innerHTML = pendingImages.map((p,i) =>
    `<div class="thumb ${p.uploading?'uploading':''}">
      <img src="${p.localPreview}">
      <button class="rm" onclick="window._rmImg(${i})">×</button>
    </div>`).join('');
}
window._rmImg = i => { pendingImages.splice(i,1); renderAttachPreview(); };

async function pickImages(files){
  if(!files || !files.length) return;
  for(const file of Array.from(files).slice(0, 5-pendingImages.length)){
    if(!file.type.startsWith('image/')) continue;
    const entry = {url:null, localPreview:URL.createObjectURL(file), uploading:true};
    pendingImages.push(entry); renderAttachPreview();
    try {
      const r = await fetch(state.server+'/upload-image', {
        method:'POST',
        headers:{'Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey,'Content-Type':file.type,'x-image-name':file.name.replace(/[^a-zA-Z0-9._-]/g,'_')},
        body: file
      });
      const d = await r.json();
      if(!r.ok || !d.url) throw new Error(d.error||'upload failed');
      entry.url = d.url; entry.uploading = false; renderAttachPreview();
    } catch(e){ pendingImages.splice(pendingImages.indexOf(entry),1); renderAttachPreview(); }
  }
}

// ── Panels content ────────────────────────────────────────────────────────────
async function loadLessons(){
  const list = $('lessonsList'); if(!list) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api('/lessons');
    const items = d.lessons || [];
    if(!items.length){ list.innerHTML = '<div class="empty">No lessons yet — chat and give feedback.</div>'; return; }
    list.innerHTML = items.map(l => `
      <div class="lesson-card">
        <div style="font-size:13px">${esc(l.lesson)}</div>
        <div style="font-size:10px;color:var(--dim);margin-top:4px">${esc(l.source||'')} · ${Math.round((l.importance||.5)*100)}%</div>
      </div>`).join('');
  } catch(e){ list.innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`; }
}

async function loadNotes(){
  const list = $('notesList'); if(!list) return;
  try {
    const d = await api('/notes');
    const items = d.notes || [];
    list.innerHTML = items.length
      ? items.map(n => `<div style="padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px"><div>${esc(n.fact)}</div><div style="font-size:10px;color:var(--dim)">${new Date(n.created_at).toLocaleString()}</div></div>`).join('')
      : '<div class="empty">No notes yet.</div>';
  } catch(e){ list.innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`; }
}

async function addNote(){
  const fact = prompt('What should KAI remember?');
  if(!fact) return;
  try { await api('/remember',{method:'POST',body:{fact}}); loadNotes(); }
  catch(e){ alert(e.message); }
}

let activeProjId = null;
async function loadProjects(){
  const list = $('projList'); if(!list) return;
  try {
    const d = await api('/projects');
    const projs = d.projects||[];
    list.innerHTML = projs.length
      ? projs.map(p=>`<div class="chatitem ${p.id===activeProjId?'active':''}" data-pid="${p.id}" style="font-size:13px">
          <span class="proj-dot ${p.status}"></span>${esc(p.title)}
        </div>`).join('')
      : '<div class="empty">No projects yet.</div>';
    list.querySelectorAll('[data-pid]').forEach(el=>{
      el.onclick=()=>{ activeProjId=el.dataset.pid; renderProj(); loadProjects(); };
    });
  } catch(e){ list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function renderProj(){
  const det = $('projDetail');
  if(!det) return;
  det.innerHTML = '<div class="empty">Select a project.</div>';
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function saveKaiKey(){
  const k = ($('kaiKeyInput')||{}).value?.trim();
  if(!k?.startsWith('kai_')){ alert('Key should start with kai_'); return; }
  state.kaiKey = k; save();
  set('enrollStat', el => el.innerHTML = '<span style="color:var(--gold)">Saving…</span>');
  await checkServer();
}
async function testKey(){
  set('enrollStat', el => el.innerHTML = 'Testing…');
  try {
    const r = await api('/ping');
    set('enrollStat', el => el.innerHTML = `<span style="color:var(--good)">✓ ${esc(r.provider||'connected')}</span>`);
  } catch(e){
    set('enrollStat', el => el.innerHTML = `<span style="color:var(--bad)">✗ ${esc(e.message)}</span>`);
  }
}
async function saveProviderKey(){
  const key = ($('apiKey')||{}).value?.trim();
  const prov = ($('provSel')||{}).value;
  if(!key){ alert('Paste a key first'); return; }
  const body = {provider:prov};
  if(prov==='groq')  body.groq_key=key;
  if(prov==='hf')    body.hf_key=key;
  try { await api('/set-key',{method:'POST',body}); alert(prov+' key saved ✓'); if($('apiKey')) $('apiKey').value=''; checkServer(); }
  catch(e){ alert('Failed: '+e.message); }
}
async function testProvider(){
  const prov = ($('provSel')||{}).value;
  const key  = ($('apiKey')||{}).value?.trim();
  try {
    const r = await api('/test-provider',{method:'POST',body:{provider:prov,key:key||undefined}});
    r.ok ? alert(`✓ ${r.provider}\n${r.reply||'OK'}`) : alert(`✗ ${r.error}`);
  } catch(e){ alert('Test failed: '+e.message); }
}
function updateProvHint(){
  const hints = {
    groq:       'Free key: console.groq.com/keys',
    hf:         'Free token: huggingface.co/settings/tokens',
    kai_builtin:'KAI Built-in — Qwen 2.5 7B, needs HF token once',
  };
  set('provHint', el => el.textContent = hints[($('provSel')||{}).value]||'');
}

// ── APK update check ──────────────────────────────────────────────────────────
async function checkForUpdate(){
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    const d = await r.json();
    const body = ((d.body||d.name||'').toUpperCase());
    const m = body.match(/BUILD ([A-Z]+)/);
    if(!m) return;
    const toN = s => s.split('').reduce((a,c)=>a*26+(c.charCodeAt(0)-64),0);
    if(toN(m[1]) > toN(BUILD)){
      const b = document.createElement('div');
      b.className = 'update-banner';
      b.innerHTML = `<span>✦ Build ${esc(m[1])} available</span><a href="${esc(d.assets?.[0]?.browser_download_url||d.html_url)}" class="ub-btn">Download</a><span class="ub-close" onclick="this.parentElement.remove()">✕</span>`;
      document.body.insertBefore(b, document.body.firstChild);
    }
  } catch {}
}

// ── Jarvis voice ──────────────────────────────────────────────────────────────
function jarvisSpeak(text){
  if(!state.jarvisEnabled) return;
  const clean = text.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/\*+/g,'').replace(/#{1,6}\s/g,'').replace(/https?:\/\/\S+/g,'link').replace(/[^\x00-\x7F]/g,' ').replace(/\s+/g,' ').trim();
  if(!clean) return;
  if(currentAudio){ try{currentAudio.pause();}catch{} currentAudio=null; }
  if('speechSynthesis' in window) speechSynthesis.cancel();
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  let i = 0;
  function next(){
    if(i >= sentences.length) return;
    const u = new SpeechSynthesisUtterance(sentences[i++].trim());
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v=>/google uk english male/i.test(v.name)) ||
              voices.find(v=>/microsoft david/i.test(v.name)) ||
              voices.find(v=>/daniel/i.test(v.name)) ||
              voices.find(v=>v.lang==='en-GB') ||
              voices.find(v=>v.lang.startsWith('en')) || null;
    u.rate=0.92; u.pitch=0.8; u.volume=state.jarvisVolume||1.0;
    u.onend=next; u.onerror=()=>{};
    speechSynthesis.speak(u);
  }
  next();
}

function jarvisGreet(){
  if(!state.jarvisEnabled || hasGreeted) return;
  hasGreeted = true;
  const h = new Date().getHours();
  const g = h<12?'Good morning':h<18?'Good afternoon':'Good evening';
  setTimeout(() => jarvisSpeak(`${g}. KAI systems online. How can I assist you?`), 1400);
}

function renderJarvisToggle(){
  set('jarvisToggle', el => {
    el.textContent = state.jarvisEnabled ? '🔊 Jarvis Voice ON' : '🔇 Jarvis Voice OFF';
    el.classList.toggle('on', state.jarvisEnabled);
  });
}
function toggleJarvis(){
  state.jarvisEnabled = !state.jarvisEnabled; save(); renderJarvisToggle();
  if(state.jarvisEnabled) jarvisSpeak('Jarvis voice enabled.');
  else if('speechSynthesis' in window) speechSynthesis.cancel();
}

// ── Mic / Voice ───────────────────────────────────────────────────────────────
function wireMic(){
  const btn = $('micBtn'); if(!btn) return;
  let ta = false;
  btn.addEventListener('touchstart', e=>{e.preventDefault();ta=true;startRec();});
  btn.addEventListener('touchend',   e=>{e.preventDefault();if(ta){ta=false;stopRec(true);}});
  btn.addEventListener('touchcancel',()=>{if(ta){ta=false;stopRec(false);}});
  btn.addEventListener('click', e=>{if(ta)return; isRecording?stopRec(true):startRec();});
  $('voiceOverlay')?.addEventListener('click',()=>{if(isRecording)stopRec(false);else $('voiceOverlay')?.classList.remove('on');});
}
async function startRec(){
  if(isRecording || !state.kaiKey) return;
  if('speechSynthesis' in window) speechSynthesis.cancel();
  try { recStream = await navigator.mediaDevices.getUserMedia({audio:true}); }
  catch(e){ alert('Mic: '+e.message); return; }
  audioChunks = [];
  const mimes=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
  let mime=''; for(const t of mimes){if(MediaRecorder.isTypeSupported(t)){mime=t;break;}}
  mediaRecorder = new MediaRecorder(recStream, mime?{mimeType:mime}:{});
  mediaRecorder.ondataavailable = e=>{if(e.data.size>0)audioChunks.push(e.data);};
  mediaRecorder.start(); isRecording=true;
  set('micBtn',el=>el.classList.add('recording'));
  $('voiceOverlay')?.classList.add('on');
  set('voStatus',el=>el.textContent='listening…');
}
async function stopRec(send_){
  if(!isRecording||!mediaRecorder) return;
  return new Promise(resolve=>{
    mediaRecorder.onstop = async()=>{
      if(recStream){recStream.getTracks().forEach(t=>t.stop());recStream=null;}
      set('micBtn',el=>el.classList.remove('recording'));
      isRecording=false;
      if(!send_||!audioChunks.length){$('voiceOverlay')?.classList.remove('on');resolve();return;}
      const blob=new Blob(audioChunks,{type:mediaRecorder.mimeType||'audio/webm'});
      audioChunks=[];
      set('voStatus',el=>el.textContent='transcribing…');
      try{await sendVoice(blob);}catch(e){set('voStatus',el=>el.textContent='error: '+e.message);setTimeout(()=>$('voiceOverlay')?.classList.remove('on'),2000);}
      resolve();
    };
    mediaRecorder.stop();
  });
}
async function sendVoice(blob){
  const headers={'Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey,'Content-Type':blob.type||'audio/webm'};
  if(currentChatId) headers['x-chat-id']=currentChatId;
  const res=await fetch(state.server+'/chat/voice',{method:'POST',headers,body:blob});
  const data=await res.json();
  if(!res.ok||data.error) throw new Error(data.error||'HTTP '+res.status);
  currentChatId=data.chat_id;
  set('voStatus',el=>el.textContent='speaking…');
  await loadCurrentChat(); await loadChatList();
  if(data.reply) jarvisSpeak(data.reply);
  else $('voiceOverlay')?.classList.remove('on');
}

// ── Self-mod panel ────────────────────────────────────────────────────────────
const SELF_PRESETS=[
  {label:'🐛 Fix latest bug',       task:'Check your recent code for bugs or errors. Fix and deploy them.'},
  {label:'✨ Add dark mode',         task:'Add a dark/light mode toggle button that switches CSS colour variables.'},
  {label:'📊 Add typing indicator', task:'Add an animated typing indicator (three dots) while KAI is thinking.'},
  {label:'⚡ Optimise performance', task:'Analyse codebase for performance bottlenecks and optimise the most impactful ones.'},
  {label:'🌐 Add web search',       task:'Add a /search command that searches the web via DuckDuckGo and summarises results.'},
  {label:'📝 Export chat as MD',    task:'Add a button to export the current chat as a formatted markdown file.'},
  {label:'🎨 Better image UI',      task:'Redesign image display: show generated images in a gallery with zoom and download buttons.'},
  {label:'🔔 Notifications',        task:'Add Web Push notification support so KAI can notify the user even in background.'},
];

function loadSelfModPanel(){
  const presets = $('selfModPresets');
  if(presets) presets.innerHTML = SELF_PRESETS.map(p=>
    `<button class="preset-btn" onclick="if($('selfModTask'))$('selfModTask').value=${JSON.stringify(p.task)}">${esc(p.label)}</button>`
  ).join('');
}

async function kaiSelfAgent(task){
  if(!task?.trim()) return;
  const btn=$('selfModRun'); const out=$('selfModOutput');
  if(btn){btn.disabled=true;btn.textContent='KAI working…';}
  if(out){out.style.display='block';out.innerHTML='';}
  const local=currentChatId?((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]):[];
  local.push({role:'user',text:'🔧 '+task});
  local.push({role:'kai',text:'🤖 KAI autonomous agent starting…',_streaming:true});
  renderMessages(local); closeAll();
  try{
    const headers={'Content-Type':'application/json','Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey};
    const res=await fetch(state.server+'/self/agent',{method:'POST',headers,body:JSON.stringify({task,chat_id:currentChatId})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||'HTTP '+res.status);}
    const reader=res.body.getReader();const decoder=new TextDecoder();
    let buffer='',accumulated='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const parts=buffer.split('\n\n');buffer=parts.pop()||'';
      for(const part of parts){
        const line=part.replace(/^data:\s*/,'').trim();if(!line)continue;
        try{
          const e=JSON.parse(line);
          if(e.type==='delta'){accumulated+=e.text;if(out)out.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;padding:10px">${esc(accumulated)}</pre>`;local[local.length-1]={role:'kai',text:accumulated,_streaming:true};renderMessages(local);}
          else if(e.type==='done'){if(e.chat_id)currentChatId=e.chat_id;local[local.length-1]={role:'kai',text:e.reply||accumulated,meta:{tokens:e.tokens||0}};renderMessages(local);await loadChatList();if(state.jarvisEnabled)jarvisSpeak('Self-modification complete.');}
          else if(e.type==='error'){throw new Error(e.error||'error');}
        }catch(pe){if(pe.message&&!pe.message.includes('JSON'))throw pe;}
      }
    }
  }catch(e){
    if(out)out.innerHTML=`<div style="color:var(--bad);padding:10px">${esc(e.message)}</div>`;
    local[local.length-1]={role:'kai',text:'⚠ '+e.message};renderMessages(local);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='▶ Run';}
  }
}

// ── Evolution panel ───────────────────────────────────────────────────────────
function checkPingForEvolution(d){
  const el=$('evolutionStatus'); if(!el) return;
  const count=d.evolution_count||0;
  const last=d.last_evolution&&d.last_evolution!=='never'?d.last_evolution.slice(0,16):'never';
  el.textContent=count+' self-improvements · last: '+last;
}

async function loadChangelog(){
  const list=$('evolutionLog'); if(!list) return;
  list.innerHTML='<div class="empty">Loading…</div>';
  try{
    const d=await api('/self/changelog');
    const items=d.changelog||[];
    if(!items.length){list.innerHTML='<div class="empty">No evolutions yet. Tap Evolve Now to trigger one.</div>';return;}
    list.innerHTML=items.map(item=>`
      <div style="padding:10px 14px;border-bottom:1px solid var(--line)">
        <div style="font-size:13px;font-weight:600">${esc(item.changelog||item.idea||'')}</div>
        <div style="font-size:11px;color:var(--dim);margin-top:3px">${esc(item.files_changed||'?')} · ${item.deployed?'<span style="color:var(--good)">live</span>':'<span style="color:var(--gold)">pending</span>'} · ${(item.created_at||'').slice(0,16)}</div>
      </div>`).join('');
    const s=$('evolutionStatus');
    if(s) s.textContent=(d.evolution_count||0)+' self-improvements deployed';
  }catch(e){list.innerHTML=`<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`;}
}

async function triggerEvolution(){
  const btn=$('evolveBtn'); const out=$('evolutionOutput');
  if(btn){btn.disabled=true;btn.textContent='KAI evolving…';}
  if(out){out.style.display='block';out.innerHTML='';}
  const local=currentChatId?((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]):[];
  local.push({role:'user',text:'KAI autonomous evolution started'});
  local.push({role:'kai',text:'🌙 KAI waking up to improve himself…',_streaming:true});
  renderMessages(local); closeAll();
  try{
    const headers={'Content-Type':'application/json','Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey};
    const res=await fetch(state.server+'/self/evolve-stream',{method:'POST',headers,body:JSON.stringify({chat_id:currentChatId})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||'HTTP '+res.status);}
    const reader=res.body.getReader();const decoder=new TextDecoder();
    let buffer='',accumulated='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const parts=buffer.split('\n\n');buffer=parts.pop()||'';
      for(const part of parts){
        const line=part.replace(/^data:\s*/,'').trim();if(!line)continue;
        try{
          const e=JSON.parse(line);
          if(e.type==='delta'){accumulated+=e.text;if(out)out.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;padding:10px">${esc(accumulated)}</pre>`;local[local.length-1]={role:'kai',text:accumulated,_streaming:true};renderMessages(local);}
          else if(e.type==='done'){if(e.chat_id)currentChatId=e.chat_id;local[local.length-1]={role:'kai',text:e.reply||accumulated,meta:{tokens:e.tokens||0}};renderMessages(local);await loadChatList();if(state.jarvisEnabled)jarvisSpeak('Evolution complete. KAI has improved himself.');const s=$('evolutionStatus');if(s)s.textContent=(e.evolution_count||0)+' self-improvements deployed';}
          else if(e.type==='error'){throw new Error(e.error||'error');}
        }catch(pe){if(pe.message&&!pe.message.includes('JSON'))throw pe;}
      }
    }
  }catch(e){
    if(out)out.innerHTML=`<div style="color:var(--bad);padding:10px">${esc(e.message)}</div>`;
    local[local.length-1]={role:'kai',text:'⚠ Evolution error: '+e.message};renderMessages(local);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Evolve Now';}
  }
}

// ── Self-eval ─────────────────────────────────────────────────────────────────
async function runSelfEvalNow(){
  const btn=$('runSelfEval'); if(btn) btn.textContent='Running…';
  try{ const r=await api('/self-eval',{method:'POST'}); if(btn)btn.textContent=r.ok?'✓ Done':'⚠ '+r.error; }
  catch(e){ if(btn)btn.textContent='⚠ '+e.message; }
  setTimeout(()=>{if($('runSelfEval'))$('runSelfEval').textContent='▶ Run self-eval now';loadLessons();},2500);
}

// ── INIT — fully defensive, every element access guarded ─────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL GEMMA 4 E2B — on-device inference via KaiGemmaLocal native plugin
// Thermal-safety-first: never generates without checking device temperature.
// ═══════════════════════════════════════════════════════════════════════════
let gemmaLocalState = { downloaded: false, loaded: false, backend: null, downloading: false };
const GEMMA_MODEL_URL = 'https://huggingface.co/litert-community/Gemma3-1B-it/resolve/main/gemma-4-e2b-it.task';

function gemmaAvailable(){
  return typeof cordova !== 'undefined' && cordova.plugins && cordova.plugins.KaiGemmaLocal;
}

async function checkGemmaStatus(){
  if(!gemmaAvailable()) return {supported:false, reason:'Plugin not available — rebuild the app with the local model plugin included.'};
  try {
    const avail = await cordova.plugins.KaiGemmaLocal.isAvailable();
    const dl = await cordova.plugins.KaiGemmaLocal.isModelDownloaded();
    gemmaLocalState.downloaded = dl.downloaded;
    return { supported:true, ...avail, ...dl };
  } catch(e) {
    return { supported:false, reason: e.message||String(e) };
  }
}

async function checkGemmaThermal(){
  if(!gemmaAvailable()) return { safe_to_generate:false, status:'unavailable' };
  try { return await cordova.plugins.KaiGemmaLocal.getThermalStatus(); }
  catch(e) { return { safe_to_generate:false, status:'error', error:e.message }; }
}

async function downloadGemmaModel(onProgress){
  if(!gemmaAvailable()) throw new Error('Plugin not available');
  gemmaLocalState.downloading = true;
  try {
    const result = await cordova.plugins.KaiGemmaLocal.downloadModel(GEMMA_MODEL_URL, onProgress);
    gemmaLocalState.downloaded = true;
    return result;
  } finally {
    gemmaLocalState.downloading = false;
  }
}

async function loadGemmaModel(backend){
  if(!gemmaAvailable()) throw new Error('Plugin not available');
  // Thermal pre-check — refuse to load if device already running warm
  const thermal = await checkGemmaThermal();
  if(thermal.supported !== false && thermal.safe_to_generate === false){
    throw new Error(`Device is running warm (${thermal.status}). Let it cool down before loading the local model.`);
  }
  const result = await cordova.plugins.KaiGemmaLocal.loadModel(backend||'cpu');
  gemmaLocalState.loaded = true;
  gemmaLocalState.backend = result.backend;
  return result;
}

async function unloadGemmaModel(){
  if(!gemmaAvailable()) return;
  try { await cordova.plugins.KaiGemmaLocal.unloadModel(); } catch{}
  gemmaLocalState.loaded = false;
}

// Called from send() when local_gemma4e2b is the active provider
async function sendLocalGemma(text, localMsgs, pidx){
  // Thermal check on EVERY generation, not just at load
  const thermal = await checkGemmaThermal();
  if(thermal.supported !== false && thermal.safe_to_generate === false){
    localMsgs[pidx] = {role:'kai', text:`⚠ Device is running warm (${thermal.status}). Pausing local generation to protect your device — try again once it cools down, or switch to a cloud model.`};
    renderMessages(localMsgs);
    return;
  }
  if(!gemmaLocalState.loaded){
    localMsgs[pidx] = {role:'kai', text:'⏳ Loading Gemma model into memory…', _streaming:true};
    renderMessages(localMsgs);
    try { await loadGemmaModel('cpu'); }
    catch(e){ localMsgs[pidx] = {role:'kai', text:'⚠ '+e.message}; renderMessages(localMsgs); return; }
  }
  try {
    let acc = '';
    await cordova.plugins.KaiGemmaLocal.generate(text, (delta, accumulated) => {
      acc = accumulated;
      localMsgs[pidx] = {role:'kai', text:acc, _streaming:true};
      renderMessages(localMsgs);
    });
    localMsgs[pidx] = {role:'kai', text:acc, meta:{tokens:Math.round(acc.length/4), local:true}};
    renderMessages(localMsgs);
    if(state.jarvisEnabled) jarvisSpeak(acc);
    // Save to server DB for history even though inference was local
    try {
      if(!currentChatId){ const c = await api('/chats'); }
      await api('/chat/local-result', {method:'POST', body:{chat_id:currentChatId, reply:acc, tokens:Math.round(acc.length/4)}});
    } catch {}
  } catch(e){
    localMsgs[pidx] = {role:'kai', text:'⚠ Local generation failed: '+e.message};
    renderMessages(localMsgs);
  }
}

function renderGemmaPanel(){
  const el = $('gemmaPanel');
  if(!el) return;
  if(!gemmaAvailable()){
    el.innerHTML = '<div class="empty">Local model plugin not present in this build. Rebuild the app to enable on-device Gemma.</div>';
    return;
  }
  el.innerHTML = '<div class="empty">Checking status…</div>';
  checkGemmaStatus().then(status => {
    let html = '';
    if(!status.meets_ram_requirement){
      html += `<div style="padding:10px 14px;color:var(--bad);font-size:12px">⚠ This device has ${status.ram_mb}MB RAM — Gemma 4 E2B recommends 4096MB+. It may run slowly or fail to load.</div>`;
    }
    if(status.downloaded){
      html += `<div style="padding:10px 14px;font-size:13px">✓ Model downloaded (${status.size_mb}MB)</div>`;
      html += `<div class="btn-row"><button class="tm-btn" onclick="loadGemmaModel(\'cpu\').then(()=>renderGemmaPanel())">Load (CPU — safest)</button></div>`;
      html += `<div class="btn-row"><button class="tm-btn" onclick="loadGemmaModel(\'gpu\').then(()=>renderGemmaPanel())">Load (GPU — faster, more heat)</button></div>`;
      html += `<div class="btn-row"><button class="tm-btn" style="color:var(--bad)" onclick="cordova.plugins.KaiGemmaLocal.deleteModel().then(()=>renderGemmaPanel())">Delete model (free ${status.size_mb}MB)</button></div>`;
    } else {
      html += `<div style="padding:10px 14px;font-size:12px;color:var(--dim)">Model not downloaded yet. Size: ~2.6GB. Recommend WiFi only.</div>`;
      html += `<div class="btn-row"><button class="tm-btn primary" id="gemmaDownloadBtn">Download model (WiFi recommended)</button></div>`;
      html += `<div id="gemmaProgress" style="padding:0 14px;font-size:12px;color:var(--gold)"></div>`;
    }
    html += `<div class="sec-label">Thermal status</div><div id="gemmaThermal" style="padding:0 14px 10px;font-size:12px;color:var(--dim)">checking…</div>`;
    el.innerHTML = html;
    checkGemmaThermal().then(t => {
      const te = $('gemmaThermal');
      if(te) te.innerHTML = t.supported===false
        ? `<span style="color:var(--dim)">${esc(t.status||'unavailable')} — ${esc(t.note||'')}</span>`
        : `<span style="color:${t.safe_to_generate?'var(--good)':'var(--bad)'}">${esc(t.status)} ${t.safe_to_generate?'— safe to run':'— device warm, generation paused for safety'}</span>`;
    });
    const dlBtn = $('gemmaDownloadBtn');
    if(dlBtn) dlBtn.onclick = async () => {
      dlBtn.disabled = true; dlBtn.textContent = 'Downloading…';
      try {
        await downloadGemmaModel(p => {
          const pe = $('gemmaProgress');
          if(pe) pe.textContent = `${p.percent}% — ${p.downloaded_mb}MB / ${p.total_mb}MB`;
        });
        renderGemmaPanel();
      } catch(e){
        dlBtn.disabled = false; dlBtn.textContent = 'Download failed — retry';
        alert('Download failed: '+e.message);
      }
    };
  });
}


function init(){
  // New chat buttons
  on('newChatTopBtn','click', newChat);
  on('newChatBtn',   'click', newChat);

  // Menu
  on('openMenu','click',()=>{ openP('scrimL','panelL'); loadChatList(); });
  on('openComputer','click',()=>{ openP('scrimC','panelC'); loadProjects(); renderProj(); });

  // Setup panel
  on('goSetup','click',()=>{
    openP('scrimS','panelS');
    set('srvUrl', el=>el.value=state.server);
    set('kaiKeyInput', el=>el.value=state.kaiKey||'');
    renderJarvisToggle(); updateProvHint(); testKey();
  });

  // Other panels
  on('goNotes',    'click', ()=>{ openP('scrimN','panelN'); loadNotes(); });
  on('goLessons',  'click', ()=>{ openP('scrimK','panelK'); loadLessons(); });
  on('goImageGen', 'click', ()=>{ closeAll(); promptImageGen(); });
  on('goReelGen',  'click', ()=>{ closeAll(); promptReelGen(); });
  on('goSelfMod',  'click', ()=>{ openP('scrimX','panelX'); loadSelfModPanel(); });
  on('goEvolution','click', ()=>{ openP('scrimE','panelE'); loadChangelog(); });
  on('goGemmaLocal','click', ()=>{ openP('scrimG','panelG'); renderGemmaPanel(); });

  // Scrims close everything
  ['scrimL','scrimS','scrimC','scrimN','scrimK','scrimX','scrimE','scrimG'].forEach(id => on(id,'click',closeAll));

  // Model picker
  on('modelPill',  'click', openModelPicker);
  on('modelScrim', 'click', closeModelPicker);
  on('agentBtn',   'click', toggleAgentMode);

  // Setup fields
  on('saveKaiKey', 'click', saveKaiKey);
  on('testKey',    'click', testKey);
  on('saveKey',    'click', saveProviderKey);
  on('testProv',   'click', testProvider);
  on('provSel',    'change', updateProvHint);
  on('forgetDev',  'click', ()=>{
    if(!confirm('Forget this device?')) return;
    delete state.kaiKey; save(); checkServer(); alert('Forgotten. Paste your key again to reconnect.');
  });

  // KAI computer panel
  on('cClose',   'click', closeAll);
  on('cRefresh', 'click', ()=>{ loadProjects(); renderProj(); });

  // Notes
  on('addNote', 'click', addNote);

  // Lessons
  on('runSelfEval','click', runSelfEvalNow);

  // Jarvis
  on('jarvisToggle','click', toggleJarvis);

  // Self-mod
  on('selfModRun','click', ()=>{ const t=($('selfModTask')||{}).value; if(t) kaiSelfAgent(t); });

  // Evolution
  on('evolveBtn','click', triggerEvolution);

  // Composer
  on('imgBtn','click', ()=>$('imgPicker')?.click());
  on('imgPicker','change', e=>{ pickImages(e.target.files); e.target.value=''; });
  on('sendBtn','click', send);
  on('input','keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
  on('input','input', e=>{ e.target.style.height='auto'; e.target.style.height=Math.min(120,e.target.scrollHeight)+'px'; });

  // Voice
  wireMic();

  // Voices load async on some devices
  if('speechSynthesis' in window) speechSynthesis.onvoiceschanged = ()=>{};

  // Boot sequence
  updateModelPill();
  updateProvHint();
  renderJarvisToggle();
  loadCurrentChat();
  checkServer();
  checkForUpdate();
  setTimeout(jarvisGreet, 1500);
  setTimeout(()=>checkServer(), 8000); // retry once if first ping is slow

  // Auto-refresh KAI Computer when panel is open
  setInterval(()=>{
    if($('panelC')?.classList.contains('on')){ loadProjects(); if(activeProjId)renderProj(); }
  }, 10000);
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
