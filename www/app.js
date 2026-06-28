// KAI — Build P — Jarvis voice + Local AI via WebLLM + all bugs fixed
(function(){
'use strict';

const DEFAULT_SERVER = 'https://hpjvnohzhpkopisfaemz.supabase.co/functions/v1/kai-brain';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwanZub2h6aHBrb3Bpc2ZhZW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDU5NTcsImV4cCI6MjA5NjE4MTk1N30.f_FubOdzFCLejJGvf-1WNzRLhe__hKzoh2IX0NcDhqM';
const DEFAULT_KAI_KEY = 'kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt';
const BUILD_TAG = 'S';
const GH_REPO   = 'luokai25/kai_app';
const GH_TOKEN  = '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';

// ── state ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let state = JSON.parse(localStorage.getItem('kai_thin') || '{}');
if(!state.server)    state.server    = DEFAULT_SERVER;
if(!state.kaiKey)    state.kaiKey    = DEFAULT_KAI_KEY;
if(!state.devSecret){
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  state.devSecret = btoa(String.fromCharCode(...a)).replace(/[+/=]/g,'').slice(0,28);
}
if(state.jarvisEnabled === undefined) state.jarvisEnabled = true;
if(state.jarvisVolume  === undefined) state.jarvisVolume  = 1.0;
function persist(){ localStorage.setItem('kai_thin', JSON.stringify(state)); }
persist();

let currentChatId = null;
let chatsCache    = [];

// ── API ────────────────────────────────────────────────────────────────────
async function api(path, opts){
  opts = opts || {};
  const headers = {
    'Content-Type':'application/json',
    'Authorization':'Bearer '+ANON_KEY,
    ...(opts.headers||{})
  };
  if(state.kaiKey) headers['x-kai-key'] = state.kaiKey;
  const res = await fetch(state.server+path, {
    method: opts.method||'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try{ data=JSON.parse(text); }catch{ data={_raw:text}; }
  if(!res.ok) throw new Error(data.error||('HTTP '+res.status));
  return data;
}

// ── status ─────────────────────────────────────────────────────────────────
let lastPingData = null;
async function checkServer(){
  try{
    if(!state.kaiKey){ setStatus('not connected',false); return false; }
    const d = await api('/ping');
    lastPingData = d;
    const provLabel = d.provider==='kai_builtin'?'KAI AI':(d.provider||'no provider');
    const keyOk = d.has_groq||d.has_hf||d.has_builtin_ai||true;
    const learnedStr = d.lessons_learned?` · ${d.lessons_learned} lessons`:'';
    setStatus(`${provLabel} · ready${learnedStr}`, true);
    updateBuiltinStatus(d);
    renderModelPicker(d);
    loadServerModels();
    return true;
  }catch(e){
    setStatus('disconnected: '+e.message, false, true);
    return false;
  }
}
function setStatus(text, ok, err){
  const dot=$('srvDot'); if(dot){ dot.classList.toggle('on',!!ok); dot.classList.toggle('err',!!err); }
  const pill=$('modepill'); if(pill) pill.textContent=text;
}

// ── helpers ────────────────────────────────────────────────────────────────
function esc(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderMarkdown(text){
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code style="background:var(--panel);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px">$1</code>')
    .replace(/```([\s\S]*?)```/g,'<pre style="background:#000;padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;margin:6px 0"><code>$1</code></pre>')
    .replace(/^### (.+)$/gm,'<div style="font-weight:700;color:var(--gold);margin:8px 0 4px;font-size:14px">$1</div>')
    .replace(/^## (.+)$/gm,'<div style="font-weight:700;color:var(--gold);margin:10px 0 4px;font-size:15px">$1</div>')
    .replace(/^# (.+)$/gm,'<div style="font-weight:700;color:var(--gold);margin:12px 0 4px;font-size:16px">$1</div>')
    .replace(/^- (.+)$/gm,'<div style="padding:2px 0 2px 12px">• $1</div>')
    .replace(/^(\d+)\. (.+)$/gm,'<div style="padding:2px 0 2px 12px">$1. $2</div>');
}

function linkify(text){
  const md = renderMarkdown(text);
  return md.replace(/(https?:\/\/[^\s<"&]+)/g,(url)=>{
    const clean = url.replace(/&amp;/g,'&');
    const isArtifact = clean.includes('/storage/v1/object/public/kai-artifacts/');
    if(isArtifact){
      const m=clean.match(/\d+_([^/]+)$/);
      const fname=m?m[1]:'file';
      const ext=(fname.split('.').pop()||'').toLowerCase();
      const icon=ext==='pdf'?'📄':ext==='md'?'📝':ext==='html'?'🌐':ext==='json'?'⚙️':ext==='csv'?'📊':'📎';
      return `<a href="${esc(clean)}" target="_blank" rel="noopener" class="artifact">${icon} ${esc(fname)}</a>`;
    }
    const disp = clean.length>50?clean.slice(0,47)+'…':clean;
    return `<a href="${esc(clean)}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline;word-break:break-all">${esc(disp)}</a>`;
  });
}

const ratedMessages = new Set();

function renderMessages(msgs){
  const c=$('msgs');
  if(!msgs.length){ c.innerHTML='<div class="empty">Start a conversation with KAI.</div>'; return; }
  c.innerHTML = msgs.map(m=>{
    const klass = m.role==='user'?'me':'kai';
    const rawText = m.text||'';
    // Extract image URLs
    const imgUrls=[
      ...(m.meta?.image_urls||[]),
      ...(rawText.match(/https?:\/\/hpjvnohzhpkopisfaemz\.supabase\.co\/storage\/v1\/object\/public\/kai-artifacts\/[^\s"<>]+/g)||[]),
      ...(rawText.match(/https?:\/\/image\.pollinations\.ai\/[^\s"<>"&]+/g)||[]),
    ].filter((u,i,a)=>a.indexOf(u)===i);
    // Extract video URLs — FIX: broader pattern, handle encoded URLs
    const vidUrls=[
      ...(rawText.match(/https?:\/\/\S+?\.(mp4|webm|mov)(\?[^\s"<>]*)?(?=[\s"<>]|$)/gi)||[]),
    ].filter((u,i,a)=>a.indexOf(u)===i);
    const imgHtml=imgUrls.map(u=>
      `<div class="img-bubble"><img src="${esc(u)}" loading="lazy" onclick="window.expandImg('${esc(u)}')" onerror="this.parentElement.style.display='none'" /></div>`
    ).join('');
    const vidHtml=vidUrls.map(u=>
      `<div class="vid-bubble"><video src="${esc(u)}" controls playsinline preload="metadata" style="width:100%;border-radius:12px;background:#000"></video><div style="font-size:10px;color:var(--dim);padding:3px 0"><a href="${esc(u)}" target="_blank" style="color:var(--gold)">Open video ↗</a></div></div>`
    ).join('');
    // Clean text of embedded media URLs
    const cleanText=rawText
      .replace(/https?:\/\/hpjvnohzhpkopisfaemz\.supabase\.co\/storage\/v1\/object\/public\/kai-artifacts\/[^\s"<>]+/g,'')
      .replace(/https?:\/\/image\.pollinations\.ai\/[^\s"<>]+/g,'')
      .replace(/https?:\/\/\S+?\.(mp4|webm|mov)(\?[^\s"<>]*)?(?=[\s"<>]|$)/gi,'')
      .trim();
    const body = m.role==='user' ? `<div style="white-space:pre-wrap">${esc(cleanText||rawText)}</div>` : `<div class="kai-body">${linkify(cleanText||rawText)}</div>`;
    const used = m.meta?.used?.length?`<div class="used">🔧 ${esc(m.meta.used.join(', '))}</div>`:'';
    const tokBadge=(m.role==='kai'&&m.meta?.tokens)?`<span class="msg-tok">~${m.meta.tokens>=1000?(m.meta.tokens/1000).toFixed(1)+'k':m.meta.tokens} tok</span>`:'';
    const agents=m.meta?.participants?.length?`<div class="agents-badge">🤖 ${m.meta.participants.map(p=>p.split('_').pop()||p).join(' · ')}</div>`:'';
    let feedbackRow='';
    if(m.role==='kai'&&m.id&&!m.meta?.error){
      const fb=m.feedback;
      feedbackRow=`<div class="fb-row" id="fb-${m.id}">
        <button class="fb-btn" onclick="window.sendFeedback('${m.id}',1)">👍</button>
        <button class="fb-btn" onclick="window.sendFeedback('${m.id}',-1)">👎</button>
        ${fb===1?'<span class="fb-note good">noted ✓</span>':fb===-1?'<span class="fb-note bad">learning ✓</span>':''}
      </div>`;
    }
    return `<div class="msg ${klass}">${imgHtml}${vidHtml}${body}${used}${agents}${tokBadge}${feedbackRow}</div>`;
  }).join('');
  c.scrollTop=c.scrollHeight;
}

window.expandImg = url=>{
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;flex-direction:column;gap:12px';
  const img=document.createElement('img');
  img.src=url; img.style.cssText='max-width:95%;max-height:85vh;border-radius:12px;object-fit:contain';
  const a=document.createElement('a'); a.href=url; a.target='_blank';
  a.textContent='Open full size ↗'; a.style.cssText='color:var(--gold);font-size:13px;text-decoration:underline';
  ov.appendChild(img); ov.appendChild(a);
  ov.onclick=e=>{ if(e.target===ov) ov.remove(); };
  document.body.appendChild(ov);
};

// ── image / reel ────────────────────────────────────────────────────────────
function promptImageGen(){
  const p=prompt('Describe the image:\n\n"sunset over cairo, photorealistic"\n"anime warrior, dramatic lighting"\n"portrait of a smiling woman, studio lighting"');
  if(p?.trim()) generateImage(p.trim());
}
function promptReelGen(){
  const t=prompt('Reel topic:\n\n"success mindset --type=motivational --style=dark-luxury"\n"5 money habits --type=finance --scenes=6"');
  if(t?.trim()) generateReel(t.trim());
}

async function generateImage(prompt, style){
  style=style||'';
  const localMsgs=currentChatId?((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]):[];
  localMsgs.push({role:'user',text:`/image ${prompt}`});
  localMsgs.push({role:'kai',text:'🎨 Generating image…',_streaming:true});
  renderMessages(localMsgs);
  try{
    const r=await api('/generate-image',{method:'POST',body:{prompt,style,chat_id:currentChatId}});
    if(r.error) throw new Error(r.error);
    if(r.chat_id) currentChatId=r.chat_id;
    localMsgs[localMsgs.length-1]={role:'kai',text:r.url,meta:{image_urls:[r.url],tokens:0}};
    renderMessages(localMsgs);
    if(state.jarvisEnabled) jarvisSpeak('Image generated.');
  }catch(e){
    localMsgs[localMsgs.length-1]={role:'kai',text:`❌ Image failed: ${e.message}`,meta:{error:true}};
    renderMessages(localMsgs);
  }
}

async function generateReel(input){
  let topic=input,type='motivational',style='minimal',scenes=5;
  const tm=input.match(/--type=(\S+)/); if(tm){type=tm[1];topic=topic.replace(tm[0],'').trim();}
  const sm=input.match(/--style=(\S+)/); if(sm){style=sm[1];topic=topic.replace(sm[0],'').trim();}
  const nm=input.match(/--scenes=(\d+)/); if(nm){scenes=parseInt(nm[1]);topic=topic.replace(nm[0],'').trim();}
  const localMsgs=currentChatId?((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]):[];
  localMsgs.push({role:'user',text:`/reel ${input}`});
  localMsgs.push({role:'kai',text:`🎬 Creating ${type} reel (${style} · ${scenes} scenes)…`,_streaming:true});
  renderMessages(localMsgs);
  try{
    const r=await api('/generate-reel',{method:'POST',body:{topic,type,style,scenes,chat_id:currentChatId}});
    if(r.error) throw new Error(r.error);
    if(r.chat_id) currentChatId=r.chat_id;
    let reply=`🎬 **${topic}** (${type} · ${style})\n${r.script_summary||''}\n\n`;
    if(r.image_urls?.length) reply+=r.image_urls.join('\n');
    localMsgs[localMsgs.length-1]={role:'kai',text:reply,meta:{image_urls:r.image_urls||[],tokens:r.tokens||0}};
    renderMessages(localMsgs);
    if(state.jarvisEnabled) jarvisSpeak('Reel created.');
  }catch(e){
    localMsgs[localMsgs.length-1]={role:'kai',text:`❌ Reel failed: ${e.message}`,meta:{error:true}};
    renderMessages(localMsgs);
  }
}

// ── feedback ────────────────────────────────────────────────────────────────
window.sendFeedback = async(messageId,rating)=>{
  if(ratedMessages.has(messageId+rating)) return;
  ratedMessages.add(messageId+rating);
  const row=$('fb-'+messageId); if(row) row.innerHTML='<span class="fb-note" style="color:var(--gold)">saving…</span>';
  try{
    await api('/feedback',{method:'POST',body:{message_id:messageId,rating}});
    if(row) row.innerHTML=rating===1?'<span class="fb-note good">👍 KAI will do more of this</span>':'<span class="fb-note bad">👎 KAI is learning</span>';
  }catch(e){ if(row) row.innerHTML='<span class="fb-note bad">failed</span>'; }
};

// ── chats ───────────────────────────────────────────────────────────────────
async function loadCurrentChat(){
  if(!currentChatId){ $('msgs').innerHTML='<div class="empty">Start a conversation with KAI.</div>'; return; }
  try{ const d=await api('/messages?chat_id='+currentChatId); renderMessages(d.messages||[]); }
  catch(e){ $('msgs').innerHTML=`<div class="empty">Couldn't load: ${esc(e.message)}</div>`; }
}
async function loadChatList(){
  try{
    const d=await api('/chats'); chatsCache=d.chats||[];
    const el=$('chatlist');
    if(!chatsCache.length){ el.innerHTML='<div class="empty">No chats yet</div>'; return; }
    const sorted=[...chatsCache].sort((a,b)=>(b.starred?1:0)-(a.starred?1:0));
    el.innerHTML=sorted.map(c=>`
      <div class="chatitem ${c.id===currentChatId?'active':''}" data-id="${c.id}">
        <div class="ci-title">${c.starred?'⭐ ':''}${esc(c.title||'Untitled')}</div>
        <div class="ci-actions">
          <button class="ci-btn" data-star="${c.id}">${c.starred?'★':'☆'}</button>
          <button class="ci-btn del" data-del="${c.id}">🗑</button>
        </div>
      </div>`).join('');
    el.querySelectorAll('.chatitem').forEach(row=>{
      row.querySelector('.ci-title').onclick=()=>{ currentChatId=row.dataset.id; loadCurrentChat(); loadChatList(); closeAll(); };
    });
    el.querySelectorAll('[data-star]').forEach(btn=>{
      btn.onclick=async e=>{ e.stopPropagation(); await starChat(btn.dataset.star); loadChatList(); };
    });
    el.querySelectorAll('[data-del]').forEach(btn=>{
      btn.onclick=async e=>{ e.stopPropagation(); await deleteChat(btn.dataset.del); };
    });
  }catch(e){ $('chatlist').innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}
async function starChat(id){ await api(`/chat/${id}/star`,{method:'POST'}); }
async function deleteChat(id){
  if(!confirm('Delete this chat?')) return;
  await api(`/chat/${id}`,{method:'DELETE'});
  if(currentChatId===id){ currentChatId=null; $('msgs').innerHTML=''; }
  loadChatList();
}
function newChat(){ currentChatId=null; $('msgs').innerHTML=''; closeAll(); $('input').focus(); }

function clearImages(){ pendingImages=[]; renderAttachPreview(); }

// ═══════════════════════════════════════════════════════════════════════════
// ██  LOCAL AI — WebLLM (runs entirely on device, no server needed)       ██
// ═══════════════════════════════════════════════════════════════════════════
let webLLMEngine = null;
let localModelLoading = false;
let localModelId = null;

// Models that actually run on phone-class hardware
const LOCAL_MODELS = [
  { id:'local_smollm2_135m',  name:'SmolLM2 135M',    icon:'📱', ram:'~200MB', speed:'⚡⚡⚡', best:'Any Android', desc:'Tiniest model — runs on any phone, very fast but basic',       hf:'HuggingFaceTB/smollm2-135m-instruct'    },
  { id:'local_smollm2_360m',  name:'SmolLM2 360M',    icon:'📱', ram:'~500MB', speed:'⚡⚡⚡', best:'Any Android', desc:'Small but capable — good for quick answers',                    hf:'HuggingFaceTB/smollm2-360m-instruct'    },
  { id:'local_smollm2_1b',    name:'SmolLM2 1.7B',    icon:'🤖', ram:'~1GB',  speed:'⚡⚡',  best:'4GB+ RAM',    desc:'Best balance of speed & quality for budget phones',            hf:'HuggingFaceTB/smollm2-1.7b-instruct'    },
  { id:'local_phi3_mini',     name:'Phi-3 Mini 3.8B', icon:'💫', ram:'~2.5GB',speed:'⚡⚡',  best:'6GB+ RAM',    desc:'Microsoft — surprisingly smart for its size',                  hf:'microsoft/Phi-3-mini-4k-instruct'       },
  { id:'local_gemma2_2b',     name:'Gemma 2 2B',      icon:'💎', ram:'~1.5GB',speed:'⚡⚡',  best:'4GB+ RAM',    desc:'Google — great quality, recommended for mid-range phones',     hf:'google/gemma-2-2b-it'                   },
  { id:'local_llama32_1b',    name:'Llama 3.2 1B',    icon:'🦙', ram:'~800MB',speed:'⚡⚡⚡', best:'3GB+ RAM',    desc:'Meta — tiny but solid, good for simple tasks',                 hf:'meta-llama/Llama-3.2-1B-Instruct'       },
  { id:'local_llama32_3b',    name:'Llama 3.2 3B',    icon:'🦙', ram:'~2GB',  speed:'⚡⚡',  best:'6GB+ RAM',    desc:'Meta — good quality, recommended for flagship phones',         hf:'meta-llama/Llama-3.2-3B-Instruct'       },
  { id:'local_qwen25_05b',    name:'Qwen 2.5 0.5B',   icon:'🐉', ram:'~400MB',speed:'⚡⚡⚡', best:'Any Android', desc:'Alibaba — incredibly small, surprisingly useful',               hf:'Qwen/Qwen2.5-0.5B-Instruct'            },
  { id:'local_qwen25_1b',     name:'Qwen 2.5 1.5B',   icon:'🐉', ram:'~1GB',  speed:'⚡⚡⚡', best:'3GB+ RAM',    desc:'Alibaba — fast and smart, great for daily use',                hf:'Qwen/Qwen2.5-1.5B-Instruct'            },
  { id:'local_qwen25_3b',     name:'Qwen 2.5 3B',     icon:'🐉', ram:'~2GB',  speed:'⚡⚡',  best:'6GB+ RAM',    desc:'Alibaba — recommended flagship local model',                   hf:'Qwen/Qwen2.5-3B-Instruct'              },
];

function getDeviceRAM(){
  // navigator.deviceMemory is in GB, supported on Android Chrome
  if(navigator.deviceMemory) return navigator.deviceMemory;
  return 4; // assume 4GB if unknown
}
function recommendLocalModel(){
  const ram = getDeviceRAM();
  if(ram>=6) return 'local_llama32_3b';
  if(ram>=4) return 'local_gemma2_2b';
  if(ram>=3) return 'local_llama32_1b';
  return 'local_smollm2_360m';
}

async function loadLocalModel(modelId){
  if(localModelLoading) return;
  const m = LOCAL_MODELS.find(x=>x.id===modelId);
  if(!m){ alert('Unknown local model'); return; }

  localModelLoading = true;
  localModelId = modelId;
  setStatus(`Loading ${m.name} locally…`, true);
  showLocalLoadingBanner(m.name);

  try{
    // WebLLM CDN — loads WASM + model weights into browser cache
    const { CreateMLCEngine } = await import('https://esm.run/@mlc-ai/web-llm@0.2.73');
    const mlcModelId = getMlcModelId(modelId);
    webLLMEngine = await CreateMLCEngine(mlcModelId, {
      initProgressCallback: (p) => {
        const pct = Math.round((p.progress||0)*100);
        updateLocalLoadingBanner(`${m.name}: ${pct}% loaded (${p.text||''})`);
        setStatus(`Loading ${m.name}… ${pct}%`, true);
      }
    });
    hideLocalLoadingBanner();
    setStatus(`✦ ${m.name} · running on device`, true);
    state.activeProvider = modelId;
    persist();
    if(state.jarvisEnabled) jarvisSpeak(`${m.name} loaded and ready. Running entirely on your device.`);
  }catch(e){
    hideLocalLoadingBanner();
    webLLMEngine = null; localModelId = null;
    setStatus('Local model failed: '+e.message, false, true);
    alert(`Failed to load ${m.name}:\n${e.message}\n\nTry a smaller model or use a cloud model instead.`);
  }finally{
    localModelLoading = false;
  }
}

function getMlcModelId(localId){
  const map = {
    local_smollm2_135m: 'SmolLM2-135M-Instruct-q4f16_1-MLC',
    local_smollm2_360m: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    local_smollm2_1b:   'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    local_phi3_mini:    'Phi-3-mini-4k-instruct-q4f16_1-MLC',
    local_gemma2_2b:    'gemma-2-2b-it-q4f16_1-MLC',
    local_llama32_1b:   'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    local_llama32_3b:   'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    local_qwen25_05b:   'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    local_qwen25_1b:    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    local_qwen25_3b:    'Qwen2.5-3B-Instruct-q4f16_1-MLC',
  };
  return map[localId] || 'SmolLM2-360M-Instruct-q4f16_1-MLC';
}

function showLocalLoadingBanner(name){
  let b=$('localLoadBanner');
  if(!b){ b=document.createElement('div'); b.id='localLoadBanner'; b.className='local-load-banner'; document.body.insertBefore(b,document.body.firstChild); }
  b.innerHTML=`<div class="llb-inner"><span class="llb-spin">◌</span><span id="llbText">Loading ${esc(name)}…</span></div>`;
}
function updateLocalLoadingBanner(text){ const el=$('llbText'); if(el) el.textContent=text; }
function hideLocalLoadingBanner(){ const b=$('localLoadBanner'); if(b) b.remove(); }

async function runLocalInference(messages, placeholderIdx, localMsgs){
  if(!webLLMEngine){ throw new Error('Local model not loaded. Select one from the Local AI section.'); }
  let accumulated='';
  const chatOpts = { messages: messages.map(m=>({role:m.role==='kai'?'assistant':m.role,content:m.content||m.text||''})) };
  const reply = await webLLMEngine.chat.completions.create({ ...chatOpts, stream:true });
  for await(const chunk of reply){
    const delta = chunk.choices[0]?.delta?.content||'';
    if(delta){
      accumulated+=delta;
      streamingTokens=Math.round(accumulated.length/4);
      updateTokenDisplay(sessionTokens+streamingTokens,true);
      localMsgs[placeholderIdx]={role:'kai',text:accumulated,_streaming:true};
      renderMessages(localMsgs);
    }
  }
  return accumulated;
}

// ── send ────────────────────────────────────────────────────────────────────
async function send(){
  const inp=$('input');
  const text=(inp.value||'').trim();
  if(!text&&!pendingImages.filter(p=>p.url).length) return;
  if(!state.kaiKey){ alert('Set your KAI API key first (menu → Setup)'); return; }
  inp.value=''; inp.style.height='44px';
  $('sendBtn').disabled=true;

  if(text.startsWith('/image ')){ await generateImage(text.slice(7).trim()); $('sendBtn').disabled=false; return; }
  if(text.startsWith('/reel ')){ await generateReel(text.slice(6).trim()); $('sendBtn').disabled=false; return; }

  const localMsgs=[];
  try{ if(currentChatId){ const d=await api('/messages?chat_id='+currentChatId); (d.messages||[]).forEach(m=>localMsgs.push(m)); } }catch{}
  localMsgs.push({role:'user',text});
  const pidx=localMsgs.length;
  localMsgs.push({role:'kai',text:'…',_streaming:true});
  renderMessages(localMsgs);

  // Check if active provider is local
  const isLocal = state.activeProvider?.startsWith('local_') || localModelId;

  try{
    if(isLocal){
      // Run inference entirely on device
      localMsgs[pidx]={role:'kai',text:`🤖 ${LOCAL_MODELS.find(m=>m.id===state.activeProvider)?.name||'Local AI'} thinking…`,_streaming:true};
      renderMessages(localMsgs);
      const msgs = localMsgs.slice(0,-1).map(m=>({role:m.role==='kai'?'assistant':m.role,content:m.text||''}));
      const reply = await runLocalInference(msgs,pidx,localMsgs);
      const tokens=Math.round(reply.length/4);
      addTokens(tokens); streamingTokens=0;
      localMsgs[pidx]={role:'kai',text:reply,meta:{tokens,used:['local_ai']}};
      renderMessages(localMsgs);
      // Save to server in background
      try{ await api('/chat/local-result',{method:'POST',body:{chat_id:currentChatId,reply,tokens}}); }catch{}
      clearImages();
      $('sendBtn').disabled=false;
      if(state.jarvisEnabled) jarvisSpeak(reply);
      return;
    }

    if(agentMode){
      localMsgs[pidx]={role:'kai',text:'🤖 All models thinking…',_streaming:true};
      renderMessages(localMsgs);
      const r=await api('/chat/agentic',{method:'POST',body:{chat_id:currentChatId,text,image_urls:pendingImages.filter(p=>p.url).map(p=>p.url)}});
      if(r.error) throw new Error(r.error);
      if(r.chat_id) currentChatId=r.chat_id;
      const tok=r.tokens||0; addTokens(tok); streamingTokens=0;
      localMsgs[pidx]={role:'kai',text:r.reply,meta:{used:r.used||[],tokens:tok,participants:r.participants}};
      renderMessages(localMsgs);
      clearImages(); $('sendBtn').disabled=false;
      if(state.jarvisEnabled) jarvisSpeak(r.reply);
      return;
    }

    const headers={
      'Content-Type':'application/json',
      'Authorization':'Bearer '+ANON_KEY,
      'x-kai-key':state.kaiKey,
    };
    const res=await fetch(state.server+'/chat/stream',{
      method:'POST',headers,
      body:JSON.stringify({chat_id:currentChatId,text,image_urls:pendingImages.filter(p=>p.url).map(p=>p.url)}),
    });
    if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.error||('HTTP '+res.status)); }
    const reader=res.body.getReader(); const decoder=new TextDecoder();
    let buffer='',accumulated='';
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      const events=buffer.split('\n\n'); buffer=events.pop()||'';
      for(const ev of events){
        const line=ev.replace(/^data:\s*/,'').trim(); if(!line) continue;
        try{
          const evt=JSON.parse(line);
          if(evt.type==='chat_id'){ currentChatId=evt.chat_id; }
          else if(evt.type==='delta'){ accumulated+=evt.text; streamingTokens=Math.round(accumulated.length/4); updateTokenDisplay(sessionTokens+streamingTokens,true); localMsgs[pidx]={role:'kai',text:accumulated,_streaming:true}; renderMessages(localMsgs); }
          else if(evt.type==='done'){ const ft=evt.tokens||streamingTokens; addTokens(ft); streamingTokens=0; localMsgs[pidx]={role:'kai',text:evt.reply,meta:{used:evt.used||[],tokens:ft}}; renderMessages(localMsgs); if(state.jarvisEnabled) jarvisSpeak(evt.reply); }
          else if(evt.type==='error'){ throw new Error(evt.error||'stream error'); }
        }catch(e){ if(e.message&&!e.message.includes('JSON')) throw e; }
      }
    }
    await loadChatList(); clearImages();
  }catch(e){
    localMsgs[pidx]={role:'kai',text:'⚠ '+e.message};
    renderMessages(localMsgs);
  }finally{
    $('sendBtn').disabled=false;
  }
}

// ── panels ──────────────────────────────────────────────────────────────────
function openP(scrim,panel){ closeAll(); $(scrim).classList.add('on'); $(panel).classList.add('on'); }
function closeAll(){ ['scrimL','panelL','scrimS','panelS','scrimC','panelC','scrimN','panelN','scrimK','panelK','scrimX','panelX','scrimE','panelE'].forEach(id=>$(id)?.classList.remove('on')); }

// ── lessons ─────────────────────────────────────────────────────────────────
async function loadLessons(){
  const list=$('lessonsList'); if(!list) return;
  list.innerHTML='<div class="empty">loading…</div>';
  try{
    const d=await api('/lessons');
    const lessons=d.lessons||[];
    if(!lessons.length){ list.innerHTML='<div class="empty">No lessons yet — chat and give feedback.</div>'; return; }
    const src={feedback:'👍/👎 feedback',self_eval:'self-eval',insight:'insight',cron:'auto'};
    list.innerHTML=lessons.map(l=>`<div class="lesson-card"><div class="lc-text">${esc(l.lesson)}</div><div class="lc-meta"><span class="lc-badge">${esc(src[l.source]||l.source)}</span><div class="lc-imp"><div class="lc-imp-fill" style="width:${Math.round((l.importance||.5)*100)}%"></div></div><span style="font-size:10px;color:var(--dim)">${Math.round((l.importance||.5)*100)}%</span></div></div>`).join('');
  }catch(e){ list.innerHTML=`<div class="empty bad">${esc(e.message)}</div>`; }
}
async function runSelfEvalNow(){
  const btn=$('runSelfEval'); if(btn) btn.textContent='running…';
  try{
    const r=await api('/self-eval',{method:'POST'});
    if(btn) btn.textContent=r.ok?'✓ Done':'⚠ '+r.error;
    setTimeout(()=>{ if(btn) btn.textContent='▶ Run self-eval now'; loadLessons(); },2000);
  }catch(e){ if(btn) btn.textContent='⚠ '+e.message; setTimeout(()=>{ if(btn) btn.textContent='▶ Run self-eval now'; },3000); }
}

// ── APK update ──────────────────────────────────────────────────────────────
async function checkForAppUpdate(){
  try{
    const r=await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`,{headers:{'Authorization':'token '+GH_TOKEN}});
    const d=await r.json();
    const body=(d.body||d.name||'').toUpperCase();
    const match=body.match(/BUILD ([A-Z]+)/);
    if(!match) return;
    const toIdx=s=>s.split('').reduce((a,c)=>a*26+(c.charCodeAt(0)-64),0);
    if(toIdx(match[1])>toIdx(BUILD_TAG)){
      const b=document.createElement('div'); b.id='updateBanner'; b.className='update-banner';
      b.innerHTML=`<span>✦ Build ${esc(match[1])} available</span><a href="${esc(d.assets?.[0]?.browser_download_url||d.html_url)}" class="ub-btn">Download</a><span class="ub-close" onclick="this.parentElement.remove()">✕</span>`;
      document.body.insertBefore(b,document.body.firstChild);
    }
  }catch{}
}

// ── tokens ──────────────────────────────────────────────────────────────────
let sessionTokens=0,streamingTokens=0;
function updateTokenDisplay(tokens,streaming=false){
  const pill=$('tokenPill'),count=$('tokenCount');
  if(!pill||!count) return;
  count.textContent=tokens>=1000?(tokens/1000).toFixed(1)+'k':String(tokens);
  pill.style.display='flex'; pill.classList.toggle('streaming',streaming);
}
function addTokens(n){ sessionTokens+=n; updateTokenDisplay(sessionTokens); }

// ── models ──────────────────────────────────────────────────────────────────
const MODELS_STATIC = [
  // OpenRouter Free
  {id:'or_openrouter_free',name:'OpenRouter Auto',      icon:'🆓',provider:'or_openrouter_free',source:'OpenRouter Free',ready:true,  desc:'Best free model auto-selected'},
  {id:'or_qwen3_coder',    name:'Qwen3 Coder 480B',    icon:'🔥',provider:'or_qwen3_coder',    source:'OpenRouter Free',ready:true,  desc:'480B coding · 1M ctx'},
  {id:'or_nemotron550b',   name:'Nemotron Ultra 550B',  icon:'🔥',provider:'or_nemotron550b',   source:'OpenRouter Free',ready:true,  desc:'NVIDIA 550B · 1M ctx'},
  {id:'or_gptoss120b',     name:'GPT-OSS 120B',         icon:'🔥',provider:'or_gptoss120b',     source:'OpenRouter Free',ready:true,  desc:'OpenAI open 120B · 131k ctx'},
  {id:'or_llama70b',       name:'Llama 3.3 70B',        icon:'🦙',provider:'or_llama70b',       source:'OpenRouter Free',ready:true,  desc:'Meta · 131k ctx'},
  {id:'or_gemma31b',       name:'Gemma 4 31B',          icon:'💎',provider:'or_gemma31b',       source:'OpenRouter Free',ready:true,  desc:'Google · 262k ctx'},
  {id:'or_kimi',           name:'Kimi K2.6',             icon:'🆓',provider:'or_kimi',           source:'OpenRouter Free',ready:true,  desc:'Moonshot · 262k ctx'},
  {id:'or_qwen80b',        name:'Qwen3 80B',             icon:'🆓',provider:'or_qwen80b',        source:'OpenRouter Free',ready:true,  desc:'Alibaba MoE · 262k ctx'},
  {id:'or_hermes405b',     name:'Hermes 3 405B',         icon:'🔥',provider:'or_hermes405b',     source:'OpenRouter Free',ready:true,  desc:'NousResearch · 131k ctx'},
  {id:'or_llama3b',        name:'Llama 3.2 3B',          icon:'🆓',provider:'or_llama3b',        source:'OpenRouter Free',ready:true,  desc:'Meta · tiny & fast'},
  {id:'or_dolphin',        name:'Dolphin 24B Venice',   icon:'🆓',provider:'or_dolphin',        source:'OpenRouter Free',ready:true,  desc:'Uncensored · 32k ctx'},
  {id:'or_lfm_think',      name:'LFM2.5 Thinking',      icon:'🆓',provider:'or_lfm_think',      source:'OpenRouter Free',ready:true,  desc:'Liquid AI thinking model'},
  // GitHub Models
  {id:'github_llama405b',  name:'Llama 3.1 405B',       icon:'🐙',provider:'github_llama405b',  source:'GitHub Models',  ready:true,  desc:'Meta · biggest free model'},
  {id:'github_gpt4o',      name:'GPT-4o',                icon:'🐙',provider:'github_gpt4o',      source:'GitHub Models',  ready:true,  desc:'OpenAI · free via GitHub'},
  {id:'github_gpt4omini',  name:'GPT-4o mini',           icon:'🐙',provider:'github_gpt4omini',  source:'GitHub Models',  ready:true,  desc:'OpenAI · fast & free'},
  {id:'github_llama8b',    name:'Llama 3.1 8B',         icon:'🐙',provider:'github_llama8b',    source:'GitHub Models',  ready:true,  desc:'Meta · lightweight'},
  // Cloud (needs key)
  {id:'groq',              name:'Llama 70B (Groq)',      icon:'⚡',provider:'groq',              source:'Groq',           ready:false, desc:'Fastest inference · needs Groq key'},
  {id:'kai_builtin',       name:'Qwen 2.5 7B',           icon:'✦', provider:'kai_builtin',       source:'HF Inference',   ready:false, desc:'KAI Built-in · needs HF token'},
  // Local AI models
  ...LOCAL_MODELS.map(m=>({
    id:m.id, name:m.name, icon:m.icon, provider:m.id, source:'Local AI 📱', ready:true,
    desc:`${m.desc} · ${m.ram} RAM · Best: ${m.best}`, isLocal:true, ramNeeded:m.ram, speed:m.speed
  })),
];
let serverModels=[...MODELS_STATIC];

async function loadServerModels(){
  try{
    const d=await api('/models');
    if(!d.models?.length) return;
    const srvMap={};
    d.models.forEach(s=>srvMap[s.id]=s);
    serverModels=MODELS_STATIC.map(m=>{ const s=srvMap[m.id]; if(!s) return m; return{...m,ready:s.ready!==false}; });
    renderModelPicker(lastPingData);
  }catch{}
}

let agentMode=false;
function toggleAgentMode(){
  agentMode=!agentMode;
  const btn=$('agentBtn');
  if(btn){ btn.classList.toggle('on',agentMode); btn.textContent=agentMode?'🤖 Agentic':'🤖'; setStatus(agentMode?'🤖 Agentic mode':'ready',!agentMode); }
}

function wireQuickChips(pingData){
  const cur=state.activeProvider||'or_openrouter_free';
  document.querySelectorAll('.mq-chip').forEach(chip=>{
    chip.classList.toggle('sel',chip.dataset.pid===cur);
    chip.onclick=async()=>{ const m=serverModels.find(x=>x.provider===chip.dataset.pid); if(m) await selectModel(m,pingData); };
  });
}

function renderModelPicker(pingData){
  const dropdown=$('modelDropdown'); if(!dropdown) return;
  const cur=state.activeProvider||'or_openrouter_free';
  const current=serverModels.find(m=>m.provider===cur)||serverModels[0];
  const pillName=$('modelPillName'),pillIcon=$('modelPillIcon'),pill=$('modelPill');
  if(pillName) pillName.textContent=current?.name||'KAI';
  if(pillIcon) pillIcon.textContent=current?.icon||'✦';
  pill?.classList.toggle('active',current?.ready!==false);
  wireQuickChips(pingData);

  const sources={};
  for(const m of serverModels){ if(!sources[m.source]) sources[m.source]=[]; sources[m.source].push(m); }
  const srcOrder=['OpenRouter Free','GitHub Models','Local AI 📱','HF Inference','Groq'];
  const srcLabel={
    'OpenRouter Free':'🆓 OpenRouter Free — always $0',
    'GitHub Models':  '🐙 GitHub Models — free',
    'Local AI 📱':    '📱 Local AI — runs on your phone, no internet needed',
    'HF Inference':   '✦ HF Inference — needs token',
    'Groq':           '⚡ Groq — bring your own key',
  };
  dropdown.innerHTML='<div class="md-handle"></div>';
  const ordered=[...srcOrder.filter(s=>sources[s]),...Object.keys(sources).filter(s=>!srcOrder.includes(s))];

  for(const src of ordered){
    const models=sources[src]||[]; if(!models.length) continue;
    const secId='mdsec_'+src.replace(/[\s📱]/g,'_');
    const hdr=document.createElement('div'); hdr.className='md-source-row';
    hdr.innerHTML=`<div class="md-source"><span>${srcLabel[src]||src}</span><span class="md-src-count">${models.length}</span></div><span class="md-src-toggle" id="tog_${secId}">▾</span>`;
    dropdown.appendChild(hdr);
    const sec=document.createElement('div'); sec.className='md-section'; sec.id=secId; sec.style.maxHeight='2000px';

    // Device RAM recommendation banner for Local AI section
    if(src==='Local AI 📱'){
      const ram=getDeviceRAM();
      const rec=recommendLocalModel();
      const recModel=LOCAL_MODELS.find(m=>m.id===rec);
      const banner=document.createElement('div');
      banner.style.cssText='padding:8px 14px;background:rgba(255,217,107,.06);border-bottom:1px solid var(--line);font-size:11px;color:var(--dim)';
      banner.innerHTML=`📱 Device RAM: ~${ram}GB · <strong style="color:var(--gold)">Recommended: ${recModel?.name||'SmolLM2 360M'}</strong> · Models download once and run offline`;
      sec.appendChild(banner);
    }

    for(const m of models){
      const isSel=m.provider===cur;
      const isLoaded=webLLMEngine&&localModelId===m.id;
      const row=document.createElement('div'); row.className='md-item'+(isSel?' selected':'');
      const speedBadge=m.isLocal?`<span style="color:#50c878;font-size:9px">${m.speed||'⚡'}</span>`:'';
      const ramBadge=m.isLocal?`<span style="font-size:9px;color:var(--dim)">${m.ramNeeded||''}</span>`:'';
      const freeBadge=!m.isLocal&&m.source!=='Groq'&&m.source!=='HF Inference'?'<span class="mi-free">FREE</span>':'';
      const localBadge=m.isLocal?(isLoaded?'<span style="color:var(--good);font-size:9px">● LOADED</span>':'<span style="color:var(--dim);font-size:9px">○ tap to load</span>'):'';
      row.innerHTML=`<span class="mi-icon">${m.icon}</span>
        <div class="mi-info">
          <div class="mi-name">${esc(m.name)}${isSel?' <span style="color:var(--gold);font-size:11px">✓</span>':''}</div>
          <div class="mi-meta">${freeBadge}${speedBadge}${ramBadge}${localBadge}</div>
          <div style="font-size:10px;color:var(--dim);margin-top:1px">${esc((m.desc||'').split('·')[0].trim())}</div>
        </div>`;
      row.onclick=()=>selectModel(m,pingData);
      sec.appendChild(row);
    }
    dropdown.appendChild(sec);
    hdr.onclick=()=>{ const s=$(secId),t=$('tog_'+secId); const c=s.classList.toggle('collapsed'); if(t) t.textContent=c?'▸':'▾'; };
  }
  const footer=document.createElement('div'); footer.className='md-footer';
  footer.innerHTML='<button class="tm-btn" id="runBenchmarkBtn" style="width:100%;font-size:12px">⚡ Benchmark cloud models</button>';
  dropdown.appendChild(footer);
  setTimeout(()=>{ if($('runBenchmarkBtn')) $('runBenchmarkBtn').onclick=runBenchmark; },0);
}

async function runBenchmark(){
  const btn=$('runBenchmarkBtn'); if(btn){btn.textContent='Running…';btn.disabled=true;}
  try{
    const r=await api('/benchmark',{method:'POST',body:{providers:'or_gptoss120b,or_nemotron550b,or_llama70b'}});
    closeModelPicker();
    if(r.ok&&r.results){
      const top=r.results.filter(x=>!x.error).sort((a,b)=>b.total_score-a.total_score);
      alert(`Benchmark done!\n\n${top.map(x=>`${x.label||x.provider}: ${Math.round(x.total_score*100)}% (${x.latency_ms}ms)`).join('\n')}\n\nBest: ${r.best||'N/A'}`);
      await loadServerModels(); renderModelPicker(lastPingData);
    }
  }catch(e){alert('Benchmark failed: '+e.message);}
  finally{if(btn){btn.textContent='⚡ Benchmark cloud models';btn.disabled=false;}}
}

async function selectModel(m,pingData){
  closeModelPicker();
  if(m.isLocal){
    // Local model — load it
    state.activeProvider=m.id; persist();
    updatePillUI(m);
    await loadLocalModel(m.id);
    return;
  }
  if(!m.ready&&m.provider==='groq'){ alert('Groq needs a key.\nGo to Setup → paste your Groq key.'); return; }
  if(!m.ready){ alert(`${m.name} not ready yet.`); return; }
  state.activeProvider=m.provider; persist();
  updatePillUI(m);
  try{
    await api('/set-key',{method:'POST',body:{provider:m.provider}});
    if(lastPingData) lastPingData.provider=m.provider;
    setStatus(`${m.name} · ready`,true);
    wireQuickChips(lastPingData);
  }catch(e){ alert('Failed to switch: '+e.message); }
}
function updatePillUI(m){
  if($('modelPillName')) $('modelPillName').textContent=m.name;
  if($('modelPillIcon')) $('modelPillIcon').textContent=m.icon||'✦';
}
function openModelPicker(){ renderModelPicker(lastPingData); $('modelDropdown').classList.add('open'); $('modelScrim').classList.add('on'); }
function closeModelPicker(){ $('modelDropdown').classList.remove('open'); $('modelScrim').classList.remove('on'); }

async function updateBuiltinStatus(pingData){
  const el=$('builtinStatus'); if(!el) return;
  el.innerHTML=pingData?.has_builtin_ai
    ?`<span style="color:var(--good)">✦ ${esc(pingData.builtin_model||'Qwen 2.5 7B')} · always connected · free</span>`
    :'<span style="color:var(--dim)">Built-in AI not configured on server.</span>';
}

// ── setup ────────────────────────────────────────────────────────────────────
async function saveKaiKey(){ const k=$('kaiKeyInput').value.trim(); if(!k.startsWith('kai_')){ alert('Should start with kai_'); return; } state.kaiKey=k; persist(); $('enrollStat').innerHTML='<span style="color:var(--gold)">saving…</span>'; await checkServer(); }
async function testKey(){
  if(!state.kaiKey){ alert('Set a key first'); return; } $('enrollStat').innerHTML='testing…';
  try{ const r=await api('/ping'); if(r.ok){ $('enrollStat').innerHTML=`<span style="color:var(--good)">✓ connected · ${esc(r.provider||'no provider')} ${r.has_groq?'· groq✓':''} ${r.has_hf?'· hf✓':''}</span>`; } else { $('enrollStat').innerHTML=`<span style="color:var(--bad)">⚠ ${esc(r.error||'failed')}</span>`; } }
  catch(e){ $('enrollStat').innerHTML=`<span style="color:var(--bad)">⚠ ${esc(e.message)}</span>`; }
}
async function saveProviderKey(){
  const key=$('apiKey').value.trim(),prov=$('provSel').value;
  if(!key){ alert('paste a key first'); return; } if(!state.kaiKey){ alert('Set KAI key first'); return; }
  const body={provider:prov};
  if(prov==='groq') body.groq_key=key;
  else if(prov==='hf') body.hf_key=key;
  else if(prov==='openai') body.openai_key=key;
  try{ await api('/set-key',{method:'POST',body}); alert(prov+' key saved ✓'); $('apiKey').value=''; checkServer(); }
  catch(e){ alert('failed: '+e.message); }
}
async function testProvider(){
  if(!state.kaiKey){ alert('Set KAI key first'); return; }
  const prov=$('provSel').value,key=$('apiKey').value.trim();
  try{ const r=await api('/test-provider',{method:'POST',body:{provider:prov,key:key||undefined}}); r.ok?alert(`✓ ${r.provider}\nreply: ${r.reply||'(empty)'}`):alert(`✗ ${r.provider}:\n${r.error}`); }
  catch(e){ alert('test failed: '+e.message); }
}
function updateProvHint(){
  const hints={groq:'Free key: console.groq.com/keys — 14,400 req/day',hf:'Free token: huggingface.co/settings/tokens',kai_builtin:'KAI Built-in — Qwen 2.5 7B, needs HF token once to activate',cerebras:'Free: cloud.cerebras.ai',mistral:'Free: console.mistral.ai'};
  const el=$('provHint'); if(el) el.textContent=hints[$('provSel')?.value]||'';
}

// ── KAI Computer ──────────────────────────────────────────────────────────────
let projectsCache=[],activeProjId=null;
async function loadProjects(){
  try{
    const d=await api('/projects'); projectsCache=d.projects||[];
    $('projList').innerHTML=projectsCache.length
      ?projectsCache.map(p=>`<div class="chatitem ${p.id===activeProjId?'active':''}" data-id="${p.id}" style="font-size:13px"><span class="proj-dot ${p.status}"></span>${esc(p.title)}<br><span style="color:var(--dim);font-size:10px">${p.current_step}/${p.plan?.length||0} · ${p.status}</span></div>`).join('')
      :'<div class="empty">No projects.<br>Ask KAI for multi-step work.</div>';
    document.querySelectorAll('#projList .chatitem').forEach(el=>{el.onclick=()=>{activeProjId=el.dataset.id;renderProj();loadProjects();};});
  }catch(e){ $('projList').innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}
function renderProj(){
  const p=projectsCache.find(x=>x.id===activeProjId);
  if(!p){ $('projDetail').innerHTML='<div class="empty">Select a project.</div>'; return; }
  const planHtml=(p.plan||[]).map((s,i)=>{
    const mark=s.status==='done'?'✓':s.status==='error'?'✕':i===p.current_step?'→':'·';
    const color=s.status==='done'?'var(--good)':s.status==='error'?'var(--bad)':i===p.current_step?'var(--gold)':'var(--dim)';
    return `<div style="padding:4px 0;color:${color};font-size:13px"><b>${mark}</b> ${esc(s.step)}${s.result?`<div style="font-size:11px;color:var(--dim);margin-left:18px">→ ${esc(String(s.result).slice(0,200))}</div>`:''}</div>`;
  }).join('')||'<i style="color:var(--dim)">No plan yet.</i>';
  const files=Object.keys(p.files||{});
  const filesHtml=files.length?files.map(f=>`<div style="padding:3px 0;font-family:monospace;font-size:11px"><span style="color:#74c0fc">📄 ${esc(f)}</span></div>`).join(''):'<i style="color:var(--dim)">No files.</i>';
  const log=(p.log||[]).slice(-12).map(l=>`<div class="log-line ${l.type}">[${new Date(l.t).toLocaleTimeString()}] ${esc(l.msg)}</div>`).join('')||'<i style="color:var(--dim)">no activity</i>';
  $('projDetail').innerHTML=`<div style="display:flex;justify-content:space-between;align-items:start;gap:6px"><div><h4 style="margin:0;font-family:var(--font);color:var(--gold)">${esc(p.title)}</h4><div style="font-size:11px;color:var(--dim)">${p.status} · ${p.current_step}/${p.plan?.length||0}</div></div><div>${p.status==='running'?`<button class="tm-btn" onclick="window._stopProj('${p.id}')">⏸</button>`:''}<button class="tm-btn danger" onclick="window._delProj('${p.id}')">🗑</button></div></div><div style="margin-top:8px;font-size:12px;color:var(--dim)">Goal: ${esc(p.goal||'(none)')}</div><div class="sec" style="padding:8px 0 4px">Plan</div>${planHtml}<div class="sec" style="padding:8px 0 4px">Files</div>${filesHtml}<div class="sec" style="padding:8px 0 4px">Log</div><div style="background:#000;padding:6px 8px;border-radius:6px;max-height:140px;overflow-y:auto">${log}</div>`;
}
window._stopProj=async id=>{try{await api('/project/'+id+'/stop',{method:'POST'});loadProjects();renderProj();}catch(e){alert(e.message);}};
window._delProj=async id=>{if(!confirm('Delete project?'))return;try{await api('/project/'+id,{method:'DELETE'});activeProjId=null;loadProjects();renderProj();}catch(e){alert(e.message);}};

// ── notes ────────────────────────────────────────────────────────────────────
async function loadNotes(){
  try{
    const d=await api('/notes');
    $('notesList').innerHTML=(d.notes||[]).length
      ?(d.notes||[]).map(n=>`<div style="padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px"><div>${esc(n.fact)}</div><div style="font-size:10px;color:var(--dim);margin-top:3px">${new Date(n.created_at).toLocaleString()}</div></div>`).join('')
      :'<div class="empty">No notes yet.</div>';
  }catch(e){ $('notesList').innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}
async function addNote(){
  const fact=prompt('What should KAI remember?'); if(!fact) return;
  try{ await api('/remember',{method:'POST',body:{fact}}); loadNotes(); }catch(e){alert(e.message);}
}

// ── image attach ──────────────────────────────────────────────────────────────
let pendingImages=[];
function renderAttachPreview(){
  const wrap=$('attachPreview');
  if(!pendingImages.length){ wrap.classList.remove('on'); wrap.innerHTML=''; return; }
  wrap.classList.add('on');
  wrap.innerHTML=pendingImages.map((p,i)=>`<div class="thumb ${p.uploading?'uploading':''}"><img src="${p.localPreview}"><button class="rm" onclick="window._removeImg(${i})">×</button></div>`).join('');
}
window._removeImg=idx=>{pendingImages.splice(idx,1);renderAttachPreview();};

async function pickImages(files){
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  if(!files||!files.length) return;
  const room=5-pendingImages.length; if(room<=0){ alert('Max 5 images'); return; }
  for(const file of Array.from(files).slice(0,room)){
    if(!file.type.startsWith('image/')) continue;
    if(file.size>10*1024*1024){ alert(`${file.name} too large`); continue; }
    const localPreview=URL.createObjectURL(file);
    const entry={url:null,name:file.name,localPreview,uploading:true};
    pendingImages.push(entry); renderAttachPreview();
    try{
      const headers={'Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey,'Content-Type':file.type,'x-image-name':file.name.replace(/[^a-zA-Z0-9._-]/g,'_')};
      const res=await fetch(state.server+'/upload-image',{method:'POST',headers,body:file});
      const data=await res.json();
      if(!res.ok||!data.url) throw new Error(data.error||'upload failed');
      entry.url=data.url; entry.uploading=false; renderAttachPreview();
    }catch(e){ pendingImages.splice(pendingImages.indexOf(entry),1); renderAttachPreview(); alert('upload failed: '+e.message); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ██  JARVIS VOICE SYSTEM                                                  ██
// ═══════════════════════════════════════════════════════════════════════════
let mediaRecorder=null,audioChunks=[],recordingStream=null,isRecording=false,currentAudio=null;

function jarvisSpeak(text){
  if(!state.jarvisEnabled) return;
  const clean=text.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/\*+/g,'').replace(/_+/g,'').replace(/#{1,6}\s/g,'').replace(/https?:\/\/\S+/g,'link').replace(/[^\x00-\x7F]/g,' ').replace(/\s+/g,' ').trim();
  if(!clean) return;
  if(currentAudio){try{currentAudio.pause();currentAudio=null;}catch{}}
  speechSynthesis.cancel();
  _ttsSpeak(clean);
}
function _ttsSpeak(text){
  if(!('speechSynthesis' in window)) return;
  const sentences=text.match(/[^.!?]+[.!?]*/g)||[text];
  let idx=0;
  function next(){
    if(idx>=sentences.length){jarvisEndSpeak();return;}
    const u=new SpeechSynthesisUtterance(sentences[idx++].trim());
    _applyJarvisVoice(u); u.onend=next; u.onerror=()=>jarvisEndSpeak();
    speechSynthesis.speak(u);
  }
  next();
}
function _applyJarvisVoice(u){
  const voices=speechSynthesis.getVoices();
  u.voice=voices.find(v=>/google uk english male/i.test(v.name))||voices.find(v=>/microsoft david/i.test(v.name))||voices.find(v=>/alex/i.test(v.name))||voices.find(v=>/daniel/i.test(v.name))||voices.find(v=>v.lang==='en-GB')||voices.find(v=>v.lang.startsWith('en'))||null;
  u.rate=0.92; u.pitch=0.8; u.volume=state.jarvisVolume||1.0;
}
function jarvisEndSpeak(){
  const ov=$('voiceOverlay');
  if(ov&&ov.classList.contains('on')&&!isRecording) ov.classList.remove('on');
  const vs=$('voStatus'); if(vs&&vs.textContent==='speaking…') vs.textContent='tap to speak';
}

let hasGreeted=false;
function jarvisGreet(){
  if(!state.jarvisEnabled||hasGreeted) return; hasGreeted=true;
  const h=new Date().getHours();
  const tod=h<12?'Good morning':h<18?'Good afternoon':'Good evening';
  const msgs=[`${tod}. KAI systems online. How can I assist you?`,`${tod}. All systems ready. What would you like to work on?`,`${tod}. I'm here. What do you need?`];
  setTimeout(()=>jarvisSpeak(msgs[Math.floor(Math.random()*msgs.length)]),1400);
}

async function startRecording(){
  if(isRecording) return;
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }
  speechSynthesis.cancel();
  if(currentAudio){try{currentAudio.pause();currentAudio=null;}catch{}}
  try{ recordingStream=await navigator.mediaDevices.getUserMedia({audio:true}); }
  catch(e){ alert('Mic permission denied: '+e.message); return; }
  audioChunks=[];
  const mimes=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'];
  let mime=''; for(const t of mimes){if(MediaRecorder.isTypeSupported(t)){mime=t;break;}}
  mediaRecorder=new MediaRecorder(recordingStream,mime?{mimeType:mime}:{});
  mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);};
  mediaRecorder.start(); isRecording=true;
  $('micBtn').classList.add('recording');
  $('voiceOverlay').classList.add('on'); $('voStatus').textContent='listening…';
}
async function stopRecording(shouldSend){
  if(!isRecording||!mediaRecorder) return;
  return new Promise(resolve=>{
    mediaRecorder.onstop=async()=>{
      if(recordingStream){recordingStream.getTracks().forEach(t=>t.stop());recordingStream=null;}
      $('micBtn').classList.remove('recording'); isRecording=false;
      if(!shouldSend||!audioChunks.length){ $('voiceOverlay').classList.remove('on'); resolve(); return; }
      const blob=new Blob(audioChunks,{type:mediaRecorder.mimeType||'audio/webm'}); audioChunks=[];
      $('voStatus').textContent='transcribing…';
      try{await sendVoice(blob);}catch(e){$('voStatus').textContent='error: '+e.message;setTimeout(()=>$('voiceOverlay').classList.remove('on'),2000);}
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
  if(!res.ok||data.error) throw new Error(data.error||('HTTP '+res.status));
  currentChatId=data.chat_id; $('voStatus').textContent='speaking…';
  await loadCurrentChat(); await loadChatList();
  if(data.audio_url){ currentAudio=new Audio(data.audio_url); currentAudio.volume=state.jarvisVolume||1.0; currentAudio.onended=jarvisEndSpeak; currentAudio.onerror=()=>{currentAudio=null;if(data.reply)jarvisSpeak(data.reply);else jarvisEndSpeak();}; try{await currentAudio.play();}catch{currentAudio=null;if(data.reply)jarvisSpeak(data.reply);else jarvisEndSpeak();} }
  else if(data.reply){ jarvisSpeak(data.reply); }
  else jarvisEndSpeak();
}
function wireMic(){
  const btn=$('micBtn'); if(!btn) return;
  let ta=false;
  btn.addEventListener('touchstart',e=>{e.preventDefault();ta=true;startRecording();});
  btn.addEventListener('touchend',e=>{e.preventDefault();if(ta){ta=false;stopRecording(true);}});
  btn.addEventListener('touchcancel',()=>{if(ta){ta=false;stopRecording(false);}});
  btn.addEventListener('click',e=>{if(ta)return;if(isRecording)stopRecording(true);else startRecording();});
  $('voiceOverlay').addEventListener('click',()=>{if(isRecording)stopRecording(false);else $('voiceOverlay').classList.remove('on');});
}

function renderJarvisToggle(){
  const el=$('jarvisToggle'); if(!el) return;
  el.textContent=state.jarvisEnabled?'🔊 Jarvis Voice ON':'🔇 Jarvis Voice OFF';
  el.classList.toggle('on',state.jarvisEnabled);
}
function toggleJarvis(){
  state.jarvisEnabled=!state.jarvisEnabled; persist(); renderJarvisToggle();
  if(state.jarvisEnabled) jarvisSpeak('Jarvis voice enabled.');
  else speechSynthesis.cancel();
}

// ── boot ────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// KAI SELF-MODIFICATION — KAI can update himself, fix bugs, add features
// ═══════════════════════════════════════════════════════════════════════════

async function loadSelfModPanel(){
  const el = $('selfModLog');
  if(!el) return;
  try {
    const logs = await api('/self/get-logs');
    const runs = logs.runs || [];
    el.innerHTML = runs.length ? runs.map(r=>`
      <div style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:12px">
        <span style="color:${r.conclusion==='success'?'var(--good)':r.conclusion==='failure'?'var(--bad)':'var(--gold)'}">${r.conclusion==='success'?'✓':r.conclusion==='failure'?'✗':'…'}</span>
        <span style="color:var(--dim);margin-left:6px">${(r.message||'').slice(0,50)}</span>
        <div style="font-size:10px;color:var(--dim);margin-top:2px">${r.status} · ${r.created_at?.slice(0,16)||''}</div>
      </div>`).join('')
    : '<div class="empty">No CI runs yet.</div>';
  } catch(e) {
    if(el) el.innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`;
  }
}

async function kaiSelfAgent(task){
  if(!task || !task.trim()) return;
  if(!state.kaiKey){ alert('Set your KAI API key first'); return; }

  const out = $('selfModOutput');
  const btn = $('selfModRun');
  if(out){ out.innerHTML = ''; out.style.display='block'; }
  if(btn){ btn.disabled=true; btn.textContent='KAI working…'; }

  // Also show in main chat
  const localMsgs = currentChatId
    ? ((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[])
    : [];
  localMsgs.push({role:'user', text:'🔧 '+task});
  localMsgs.push({role:'kai', text:'🤖 KAI autonomous agent starting…', _streaming:true});
  renderMessages(localMsgs);
  closeAll();

  try {
    const headers = {
      'Content-Type':'application/json',
      'Authorization':'Bearer '+ANON_KEY,
      'x-kai-key': state.kaiKey,
    };
    const res = await fetch(state.server+'/self/agent', {
      method:'POST', headers,
      body: JSON.stringify({ task, chat_id: currentChatId }),
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || 'HTTP '+res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', accumulated = '';
    while(true){
      const {done, value} = await reader.read(); if(done) break;
      buffer += decoder.decode(value, {stream:true});
      const events = buffer.split('

'); buffer = events.pop()||'';
      for(const ev of events){
        const line = ev.replace(/^data:\s*/,'').trim(); if(!line) continue;
        try {
          const e = JSON.parse(line);
          if(e.type==='delta'){
            accumulated += e.text;
            if(out) out.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;color:var(--ink);margin:0">${esc(accumulated)}</pre>`;
            localMsgs[localMsgs.length-1] = {role:'kai', text:accumulated, _streaming:true};
            renderMessages(localMsgs);
          } else if(e.type==='done'){
            if(e.chat_id) currentChatId = e.chat_id;
            localMsgs[localMsgs.length-1] = {role:'kai', text:e.reply||accumulated, meta:{tokens:e.tokens||0}};
            renderMessages(localMsgs);
            await loadChatList();
            if(state.jarvisEnabled) jarvisSpeak('Self-modification complete.');
          } else if(e.type==='error'){
            throw new Error(e.error||'stream error');
          }
        } catch(pe){ if(pe.message&&!pe.message.includes('JSON')) throw pe; }
      }
    }
  } catch(e){
    const msg = '⚠ '+e.message;
    if(out) out.innerHTML = `<div style="color:var(--bad);font-size:13px;padding:8px">${esc(msg)}</div>`;
    localMsgs[localMsgs.length-1] = {role:'kai', text:msg};
    renderMessages(localMsgs);
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='▶ Run'; }
  }
}

// Quick self-mod commands
const SELF_MOD_PRESETS = [
  { label:'🐛 Fix latest bug',      task:'Check your recent code for any bugs, logic errors, or issues. Fix them and deploy.' },
  { label:'✨ Add dark mode toggle', task:'Add a dark/light mode toggle button to the UI that switches CSS color variables.' },
  { label:'📊 Add typing indicator', task:'Add an animated typing indicator (three dots) that shows while KAI is thinking.' },
  { label:'🔔 Add push notifications',task:'Add browser Web Push notification support so KAI can notify the user even when the app is in background.' },
  { label:'⚡ Optimize performance', task:'Analyze the codebase for performance bottlenecks and optimize the most impactful ones.' },
  { label:'🧹 Clean up UI',          task:'Review the index.html and app.js for any UI inconsistencies, fix them, and make the design cleaner.' },
  { label:'📝 Add markdown export',  task:'Add a button to export the current chat as a formatted markdown file.' },
  { label:'🌐 Add web search',       task:'Add a /search command that lets KAI search the web via a free search API and summarize results.' },
];

function renderSelfModPresets(){
  const el = $('selfModPresets');
  if(!el) return;
  el.innerHTML = SELF_MOD_PRESETS.map(p=>`
    <button class="preset-btn" onclick="$('selfModTask').value=${JSON.stringify(p.task)}">${esc(p.label)}</button>
  `).join('');
}


// KAI AUTONOMOUS EVOLUTION — watch KAI improve himself in real time
async function loadChangelog(){
  const list=$('evolutionLog'); if(!list) return;
  list.innerHTML='<div class="empty">Loading...</div>';
  try{
    const d=await api('/self/changelog');
    const items=d.changelog||[];
    if(!items.length){list.innerHTML='<div class="empty" style="padding:16px">KAI has not improved himself yet.<br>Tap Evolve Now to trigger one.</div>';return;}
    list.innerHTML=items.map(item=>
      `<div style="padding:10px 14px;border-bottom:1px solid var(--line)">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${esc(item.changelog||item.idea||'')}</div>
        <div style="font-size:11px;color:var(--dim);margin-top:3px">
          ${esc(item.files_changed||'unknown')} &nbsp;·&nbsp;
          ${item.deployed?'<span style="color:var(--good)">live</span>':'<span style="color:var(--gold)">pending</span>'}
          &nbsp;·&nbsp; ${(item.created_at||'').slice(0,16)}
        </div>
      </div>`).join('');
    const statusEl=$('evolutionStatus');
    if(statusEl) statusEl.textContent=(d.evolution_count||0)+' self-improvements deployed';
  }catch(e){if(list)list.innerHTML=`<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`;}
}

async function triggerEvolution(){
  const btn=$('evolveBtn'); const out=$('evolutionOutput');
  if(btn){btn.disabled=true; btn.textContent='KAI evolving...';}
  if(out){out.style.display='block'; out.innerHTML='';}
  const localMsgs=currentChatId?((await api('/messages?chat_id='+currentChatId).catch(()=>({messages:[]}))).messages||[]):[];
  localMsgs.push({role:'user',text:'KAI autonomous evolution started'});
  localMsgs.push({role:'kai',text:'KAI waking up to improve himself...', _streaming:true});
  renderMessages(localMsgs);
  closeAll();
  try{
    const headers={'Content-Type':'application/json','Authorization':'Bearer '+ANON_KEY,'x-kai-key':state.kaiKey};
    const res=await fetch(state.server+'/self/evolve-stream',{method:'POST',headers,body:JSON.stringify({chat_id:currentChatId})});
    if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error(err.error||'HTTP '+res.status);}
    const reader=res.body.getReader(); const decoder=new TextDecoder();
    let buffer='',accumulated='';
    while(true){
      const{done,value}=await reader.read(); if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const events=buffer.split('\n\n'); buffer=events.pop()||'';
      for(const ev of events){
        const line=ev.replace(/^data:\s*/,'').trim(); if(!line)continue;
        try{
          const e=JSON.parse(line);
          if(e.type==='delta'){
            accumulated+=e.text;
            if(out) out.innerHTML='<pre style="white-space:pre-wrap;font-size:12px;color:var(--ink);margin:0;padding:10px">'+esc(accumulated)+'</pre>';
            localMsgs[localMsgs.length-1]={role:'kai',text:accumulated,_streaming:true};
            renderMessages(localMsgs);
          } else if(e.type==='done'){
            if(e.chat_id) currentChatId=e.chat_id;
            localMsgs[localMsgs.length-1]={role:'kai',text:e.reply||accumulated,meta:{tokens:e.tokens||0}};
            renderMessages(localMsgs);
            await loadChatList();
            if(state.jarvisEnabled) jarvisSpeak('Evolution complete. KAI has improved himself.');
            const evEl=$('evolutionStatus');
            if(evEl) evEl.textContent=(e.evolution_count||0)+' self-improvements deployed';
          } else if(e.type==='error'){throw new Error(e.error||'evolution error');}
        }catch(pe){if(pe.message&&!pe.message.includes('JSON'))throw pe;}
      }
    }
  }catch(e){
    const msg='Evolution error: '+e.message;
    if(out) out.innerHTML='<div style="color:var(--bad);padding:10px">'+esc(msg)+'</div>';
    localMsgs[localMsgs.length-1]={role:'kai',text:msg};
    renderMessages(localMsgs);
  }finally{
    if(btn){btn.disabled=false; btn.textContent='Evolve Now';}
  }
}

function checkPingForEvolution(d){
  const el=$('evolutionStatus'); if(!el) return;
  const count=d.evolution_count||0;
  const last=d.last_evolution&&d.last_evolution!=='never'?d.last_evolution.slice(0,16):'never';
  el.textContent=count+' self-improvements · last: '+last;
}


function init(){
  if($('newChatTopBtn')) $('newChatTopBtn').onclick=newChat;
  if($('newChatBtn'))    $('newChatBtn').onclick=newChat;
  $('openMenu').onclick=()=>{openP('scrimL','panelL');loadChatList();};
  $('openComputer').onclick=()=>{openP('scrimC','panelC');loadProjects();renderProj();};
  $('goSetup').onclick=()=>{openP('scrimS','panelS');$('srvUrl').value=state.server;$('kaiKeyInput').value=state.kaiKey||'';renderJarvisToggle();updateProvHint();testKey();};
  $('goNotes').onclick=()=>{openP('scrimN','panelN');loadNotes();};
  $('goLessons').onclick=()=>{openP('scrimK','panelK');loadLessons();};
  if($('runSelfEval')) $('runSelfEval').onclick=runSelfEvalNow;
  if($('goImageGen'))  $('goImageGen').onclick=()=>{closeAll();promptImageGen();};
  if($('goSelfMod'))   $('goSelfMod').onclick=()=>{openP('scrimX','panelX');loadSelfModPanel();};
  if($('goEvolution')) $('goEvolution').onclick=()=>{openP('scrimE','panelE');loadChangelog();};
  if($('evolveBtn'))   $('evolveBtn').onclick=triggerEvolution;
  if($('goReelGen'))   $('goReelGen').onclick=()=>{closeAll();promptReelGen();};
  if($('agentBtn'))    $('agentBtn').onclick=toggleAgentMode;
  if($('modelPill'))   $('modelPill').onclick=openModelPicker;
  if($('modelScrim'))  $('modelScrim').onclick=closeModelPicker;
  if($('jarvisToggle')) $('jarvisToggle').onclick=toggleJarvis;
  ['scrimL','scrimS','scrimC','scrimN','scrimK','scrimX','scrimE'].forEach(id=>{if($(id)) $(id).onclick=closeAll;});
  if(!state.activeProvider) state.activeProvider='or_openrouter_free';
  $('saveKaiKey').onclick=saveKaiKey; $('testKey').onclick=testKey;
  $('saveKey').onclick=saveProviderKey; $('testProv').onclick=testProvider;
  $('provSel').addEventListener('change',updateProvHint);
  $('forgetDev').onclick=()=>{if(!confirm('Forget this device?'))return;delete state.kaiKey;persist();checkServer();alert('forgotten');};
  $('addNote').onclick=addNote; $('cClose').onclick=closeAll; $('cRefresh').onclick=()=>{loadProjects();renderProj();};
  wireMic();
  $('imgBtn').onclick=()=>$('imgPicker').click();
  $('imgPicker').onchange=e=>{pickImages(e.target.files);e.target.value='';};
  $('sendBtn').onclick=send;
  $('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
  $('input').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(120,e.target.scrollHeight)+'px';});
  if('speechSynthesis' in window) speechSynthesis.onvoiceschanged=()=>{};
  renderSelfModPresets();
  loadCurrentChat(); checkServer(); checkForAppUpdate();
  setTimeout(loadServerModels,3000);
  setTimeout(jarvisGreet,1500);
  setInterval(()=>{if($('panelC')?.classList.contains('on')){loadProjects();if(activeProjId)renderProj();}},10000);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();
})();
