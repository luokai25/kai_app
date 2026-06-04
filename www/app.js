// KAI app — fused chat + graphs, local/API hybrid brain.
const $=id=>document.getElementById(id);
// WebView-safe local loaders: fetch() is unreliable on file:// in Android WebView.
function xhrBuffer(url){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('GET',url,true);x.responseType='arraybuffer';x.onload=()=>{if(x.status===0||x.status===200)res(x.response);else rej(new Error('xhr '+x.status));};x.onerror=()=>rej(new Error('xhr error '+url));x.send();});}
function xhrJSON(url){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('GET',url,true);x.onload=()=>{try{res(JSON.parse(x.responseText));}catch(e){rej(e);}};x.onerror=()=>rej(new Error('xhr error '+url));x.send();});}
let DB=null, PROFILE=null, GRAPH=null;
let chats=[], current=null;            // chats: {id,title,msgs:[{role,text}],vault:Set(person)}
let api={provider:null,key:null};
window.__api=api;  // shared ref, never reassigned
let MEMORY=[];  // persistent cross-chat memory (facts KAI keeps)
function loadMem(){ try{ MEMORY=JSON.parse(localStorage.getItem('kai_memory')||'[]'); }catch(e){ MEMORY=[]; } }
function rememberFact(f){ if(f&&!MEMORY.includes(f)){ MEMORY.push(f); if(MEMORY.length>200)MEMORY.shift(); try{localStorage.setItem('kai_memory',JSON.stringify(MEMORY));}catch(e){} } }      // active API (null = local)

// ---------- storage (in-memory + localStorage for chats/api) ----------
// FIXED: separate API save from chat save. saveChats() never touches api.
// saveApiToStorage() is the ONLY place that writes api, and only when api.key exists.
function saveChats(){ try{
  localStorage.setItem('kai_chats',JSON.stringify(chats.map(c=>({id:c.id,title:c.title,msgs:c.msgs,vault:[...c.vault]}))));
}catch(e){} }
function saveApiToStorage(){
  // Only persist when we actually have a key; never overwrite stored creds with null/empty
  try{
    if(api && api.key && api.provider){
      localStorage.setItem('kai_api',JSON.stringify({provider:api.provider,key:api.key}));
    }
  }catch(e){}
}
// Legacy alias so existing callers don't break — but now save() only saves chats
function save(){ saveChats(); }
function load(){
  // Load chats (safe to fail independently)
  try{
    const c=JSON.parse(localStorage.getItem('kai_chats')||'[]');
    chats=c.map(x=>({...x,vault:new Set(x.vault||[])}));
  }catch(e){ chats=[]; }
  // Load api independently — failure of chats must NOT wipe api
  try{
    const a=JSON.parse(localStorage.getItem('kai_api')||'null');
    if(a && a.key && a.provider){ api.provider=a.provider; api.key=a.key; window.__api=api; }
  }catch(e){}
}

// ---------- boot ----------
let READY=false, BOOT_ERR=null;
async function boot(){
  load(); loadMem();
  // apply persisted theme
  try{
    const th=JSON.parse(localStorage.getItem('kai_theme')||'null');
    if(th){
      const r=document.documentElement;
      if(th.bg)r.style.setProperty('--bg',th.bg);
      if(th.panel)r.style.setProperty('--panel',th.panel);
      if(th.gold)r.style.setProperty('--gold',th.gold);
      if(th.ink)r.style.setProperty('--ink',th.ink);
    }
  }catch(e){}
  renderChatList();
  if(!chats.length) newChat(); else current=chats[0];
  renderMessages();
  try{
    PROFILE=await xhrJSON('self_profile.json').catch(()=>({}));
    GRAPH=await xhrJSON('people_graph.json').catch(()=>({nodes:[],edges:[]}));
    const TRAINED=await xhrJSON('trained_voice.json').catch(()=>({}));
    const IDENTITY=await xhrJSON('identity.json').catch(()=>({}));
    TRAINED.identity=IDENTITY;
    drawFullGraph();  // graph only needs the json, not the DB — draw it early
    let wasmBin=null;
    try{ wasmBin=await xhrBuffer('sql-wasm.wasm'); }catch(e){}
    const SQL=await initSqlJs(wasmBin?{wasmBinary:wasmBin}:{locateFile:()=>'sql-wasm.wasm'});
    // APK ships the raw .db. Read via XHR (fetch() is unreliable on file:// in WebView).
    let bytes;
    try{
      bytes=new Uint8Array(await xhrBuffer('app_corpus.db'));
    }catch(e){
      const gz=new Uint8Array(await xhrBuffer('app_corpus.db.gz'));
      bytes=pako.ungzip(gz);
    }
    DB=new SQL.Database(bytes);
    KaiVoice.init(DB,PROFILE,TRAINED);

    // Load KAI's skill library (9,786 Claude-style skills)
    try{
      let sbytes;
      try{ sbytes=new Uint8Array(await xhrBuffer('kai_skills.db')); }
      catch(e){ const gz=new Uint8Array(await xhrBuffer('kai_skills.db.gz')); sbytes=pako.ungzip(gz); }
      const sdb=new SQL.Database(sbytes);
      window.KAI_SKILLS_DB = sdb;
      KaiSkills.init(sdb);
      console.log('KAI skills loaded:', KaiSkills.stats());
    }catch(e){ console.warn('skills load failed',e); }
    // Load KAI's 6 KNOWLEDGE PILLARS (410k total entries)
    async function loadPillar(name, file, dbVar){
      try{
        let bytes;
        try{ bytes=new Uint8Array(await xhrBuffer(file+'.db')); }
        catch(e){ const gz=new Uint8Array(await xhrBuffer(file+'.db.gz')); bytes=pako.ungzip(gz); }
        window[dbVar] = new SQL.Database(bytes);
        console.log('pillar loaded:', name);
      }catch(e){ console.warn('pillar '+name+' failed:',e.message); }
    }
    await loadPillar('code',         'kai_code',         'KAI_CODE');
    await loadPillar('reasoning',    'kai_reason',       'KAI_REASON');
    await loadPillar('writing',      'kai_writing',      'KAI_WRITE');
    await loadPillar('research',     'kai_research',     'KAI_RESEARCH');
    await loadPillar('productivity', 'kai_productivity', 'KAI_PROD');
    await loadPillar('chat',         'kai_chat',         'KAI_CHAT');
    READY=true;
    if(api.key&&api.provider) setModeLabel(api.provider);
    renderChatList();
    setStatus(api.provider?api.provider:'local');
    // --- Start KAI's ambient thinking (every 15 min by default) ---
    try{
      KaiBackground.notifyPermission();
      const bgOn = localStorage.getItem('kai_bg_on');
      if(bgOn !== '0'){  // default ON unless explicitly disabled
        KaiBackground.start(15, ambientThink);
        console.log('KAI ambient thinking ON');
      }
    }catch(e){ console.warn('bg start failed',e); }
  }catch(e){
    BOOT_ERR=e;
    const el=$('modepill');
    el.innerHTML='<b style="color:#ff8787">load failed: '+esc(String(e&&e.message||e)).slice(0,60)+' — tap to retry</b>';
    el.onclick=()=>{el.onclick=null;boot();};
    console.error('boot failed',e);
  }
}
function setStatus(mode){
  const el=$('modepill');
  if(mode==='error'){ el.innerHTML='<b style="color:#ff8787">memory failed to load — tap to retry</b>'; el.onclick=()=>{el.onclick=null;boot();}; return; }
  el.innerHTML = mode==='local'
    ? 'brain: <b>local</b> · memory: your 527k messages'
    : 'brain: <b>'+mode+'</b> · memory: your 527k messages (local)';
}

// ---------- chats ----------
function newChat(){
  const c={id:'c'+Date.now(),title:'New conversation',msgs:[],vault:new Set()};
  chats.unshift(c); current=c; save(); renderChatList(); openChat(c.id); closeAll();
}
function openChat(id){
  current=chats.find(c=>c.id===id)||chats[0]; if(!current) return;
  renderMessages(); renderChatList(); drawVault();
}
function renderChatList(){
  const el=$('chatlist'); el.innerHTML='';
  chats.forEach(c=>{
    const d=document.createElement('div');
    d.className='chatitem'+(current&&c.id===current.id?' active':'');
    const last=c.msgs.length?c.msgs[c.msgs.length-1].text:'—';
    d.innerHTML=`${esc(c.title)}<small>${esc(last.slice(0,38))}</small>`;
    d.onclick=()=>{openChat(c.id);closeAll();};
    el.appendChild(d);
  });
}
function renderMessages(){
  const el=$('chat'); el.innerHTML='';
  if(!current.msgs.length){
    el.innerHTML=`<div class="empty"><div class="orb">✦</div>
      <p>I'm KAI — made from your own words. Talk to me. I remember your people: Rosé, Rawan, your sisters, all of them.</p></div>`;
    return;
  }
  current.msgs.forEach(m=>{
    const d=document.createElement('div');
    d.className='msg '+(m.role==='me'?'me':'kai');
    let inner='<div class="who">'+(m.role==='me'?'You':'Kai')+'</div>';
    if(m.text) inner+=esc(m.text).replace(/\n/g,'<br>');
    if(m.html) inner+=m.html;
    if(m.url) inner+='<div style="margin-top:8px"><a class="tm-btn" href="'+m.url+'" target="_blank" rel="noopener">Open ↗</a></div>';
    d.innerHTML=inner;
    el.appendChild(d);
  });
  el.scrollTop=el.scrollHeight;
}

// ---------- sending ----------
async function send(){
  const inp=$('input'); const text=(inp.value||'').trim();
  if(!text) return;
  if(!current){ newChat(); }
  inp.value=''; inp.style.height='44px';
  current.msgs.push({role:'me',text});
  if(current.title==='New conversation') current.title=text.slice(0,30);
  renderMessages(); renderChatList(); save();

  const person=detectPerson(text);
  if(person) current.vault.add(person);

  // thinking placeholder (use a stable marker, not a unicode char)
  const thinking={role:'kai',text:'…',_t:1}; current.msgs.push(thinking); renderMessages();

  let reply;
  try{
    // --- tools first: if this is an action, do it ---
    const intent=KaiTools.detect(text);
    if(intent){
      const res=await KaiTools.run(intent);
      if(res){
        const i=current.msgs.indexOf(thinking); if(i>=0) current.msgs.splice(i,1);
        if(res.html){ current.msgs.push({role:'kai',text:res.say||'',html:res.html}); }
        else {
          let body=(res.say||'')+(res.extra||'');
          if(res.url) current.msgs.push({role:'kai',text:body,url:res.url});
          else current.msgs.push({role:'kai',text:body});
        }
        save(); renderMessages(); renderChatList(); drawVault();
        return;
      }
    }
    if(!READY){
      reply="(still loading your memories — one moment, then ask me again)";
    } else if(api.key&&api.provider){
      const selfNotes=KaiWorkspace.getSelfNotes();
      let sys=KaiVoice.buildSystem(person)
        +(MEMORY.length?('\n\nLong-term memory:\n- '+MEMORY.slice(-15).join('\n- ')):'')
        +(selfNotes.length?('\n\nWhat you remember about Kai:\n- '+selfNotes.slice(-15).join('\n- ')):'')
        +'\n\nYou have KAI COMPUTER — a persistent workspace where projects run in background, independent of your chat reply. For any multi-step or long-running task (research, build a website, draft a long doc, code a feature), use project_create + project_plan to start it. The project KEEPS RUNNING after this reply ends. Use project_step + project_file_write as you progress. For quick questions, just answer directly with your other tools. You also have 6 knowledge pillars (code_lookup, reasoning_lookup, writing_lookup, research_lookup, productivity_lookup, chat_lookup), the skill library (find_skill/load_skill), self-evolution (github_propose_fix opens a PR for code changes), vault/goals/specialists. Be proactive — when Kai asks for something substantial, propose making it a project. Stay brief in chat replies. English by default, Arabic only if Kai uses Arabic. Never mix.';
      // chat history (recent turns)
      const hist=current.msgs.filter(m=>!m._t).slice(-8).map(m=>({role:m.role==='me'?'user':'assistant',content:m.text||''}));
      hist.push({role:'user',content:text});
      // Fallback to simple chat if Workspace tools not loaded yet
      let out;
      if(window.KaiWorkspace && KaiWorkspace.TOOLS){
        out = await Providers.agenticChat(api.provider,api.key,hist,sys,KaiWorkspace.TOOLS,(n,a)=>KaiWorkspace.exec(n,a));
      } else {
        const txt = await Providers.chat(api.provider,api.key,hist,sys);
        out = {text:txt, used:[], extra:null};
      }
      reply=out.text;
      // attach inline html (e.g. music player) if a tool returned it
      if(out.extra && out.extra.html){
        // remove thinking, push the tool html message, then reply
        const i=current.msgs.indexOf(thinking); if(i>=0) current.msgs.splice(i,1);
        current.msgs.push({role:'kai', text: '(used '+(out.used.join(', ')||'none')+')', html: out.extra.html});
        current.msgs.push({role:'kai', text: reply||""});
        save(); renderMessages(); renderChatList(); drawVault();
        try{ KaiSpeech.speak(reply); }catch(e){}
        return;
      }
      if(out.used && out.used.length) reply = reply + '\n\n_used: '+out.used.join(', ')+'_';
    } else {
      reply=KaiVoice.localReply(text,person);
    }
  }catch(e){
    console.error('send error',e);
    reply="(couldn't reach the API — staying local)\n"+(READY?KaiVoice.localReply(text,person):"still loading.");
  }
  // remove thinking marker
  const i=current.msgs.indexOf(thinking); if(i>=0) current.msgs.splice(i,1);
  current.msgs.push({role:'kai',text:reply||"i'm here."});
  if(READY){ try{ KaiVoice.recall(text,null,4).forEach(m=>{ if(m.person&&m.person!=='Kai') current.vault.add(m.person); }); }catch(e){} }
  save(); renderMessages(); renderChatList(); drawVault();
  try{ KaiSpeech.speak(reply); }catch(e){}
}

function detectPerson(text){
  const t=text.toLowerCase();
  for(const n of (GRAPH.nodes||[])){
    if(n.id==='Kai') continue;
    if(t.includes(n.id.toLowerCase())) return n.id;
    // alias match
  }
  return null;
}

// ---------- graphs ----------
function drawGraph(canvas, nodes, edges, info, onTap){
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  function size(){ canvas.width=(canvas.clientWidth||300)*dpr; canvas.height=(canvas.clientHeight||400)*dpr; }
  size();
  const W=()=>canvas.width, H=()=>canvas.height;
  const cx=()=>W()/2, cy=()=>H()/2;
  const others=nodes.filter(n=>n.id!=='Kai');
  function layout(){
    others.forEach((n,i)=>{
      const a=(i/others.length)*Math.PI*2 - Math.PI/2;
      const r=Math.min(W(),H())*0.34*(0.78+0.22*((i*53%17)/17));
      n._x=cx()+Math.cos(a)*r; n._y=cy()+Math.sin(a)*r;
    });
    const kai=nodes.find(n=>n.id==='Kai'); if(kai){kai._x=cx();kai._y=cy();}
  }
  layout();
  let view={s:1,x:0,y:0};
  function draw(){
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
    ctx.save(); ctx.translate(view.x,view.y); ctx.scale(view.s,view.s);
    // edges
    edges.forEach(e=>{
      const a=nodes.find(n=>n.id===e.from),b=nodes.find(n=>n.id===e.to); if(!a||!b)return;
      ctx.beginPath();ctx.moveTo(a._x/dpr,a._y/dpr);ctx.lineTo(b._x/dpr,b._y/dpr);
      ctx.strokeStyle='rgba(120,110,90,.25)';ctx.lineWidth=Math.min(4,Math.log((e.w||10))/2);ctx.stroke();
    });
    // nodes
    nodes.forEach(n=>{
      const x=n._x/dpr,y=n._y/dpr,r=(n.size||16)*0.5;
      ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fillStyle=n.color||'#888';ctx.fill();
      ctx.fillStyle='#f3ead6';ctx.font='600 11px Segoe UI';ctx.textAlign='center';
      ctx.fillText(n.label,x,y+r+13);
    });
    ctx.restore();
  }
  draw();
  // interactions: pan, pinch, tap
  let drag=null,pinch=null;
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false};};
  canvas.onpointermove=e=>{ if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true; view.x=drag.vx+dx;view.y=drag.vy+dy;draw();}};
  canvas.onpointerup=e=>{
    if(drag&&!drag.moved){ // tap → hit test
      const mx=(e.offsetX-view.x)/view.s, my=(e.offsetY-view.y)/view.s;
      let hit=null;
      nodes.forEach(n=>{const x=n._x/dpr,y=n._y/dpr,r=(n.size||16)*0.5;
        if((mx-x)**2+(my-y)**2<r*r*1.6) hit=n;});
      if(hit&&onTap)onTap(hit);
    }
    drag=null;
  };
  canvas.onwheel=e=>{e.preventDefault();const f=e.deltaY<0?1.1:0.9;view.s=Math.max(.3,Math.min(3,view.s*f));draw();};
  return {redraw:()=>{size();layout();draw();}};
}

let fullG=null, vaultG=null;
function drawFullGraph(){
  fullG=drawGraph($('fullgraph'),GRAPH.nodes,GRAPH.edges,$('fullInfo'),(n)=>{
    if(n.id==='Kai'){$('fullInfo').innerHTML='<b>Kai</b> — you, the center of all of it.';return;}
    const r=PROFILE.relationships?.[n.id]||{};
    $('fullInfo').innerHTML=`<b>${n.id}</b> — ${r.desc||''}<br>${(r.messages||0).toLocaleString()} messages · ${(r.platforms?Object.keys(r.platforms).join(', '):'')}`;
  });
}
function drawVault(){
  // Obsidian-style graph: nodes = concepts/keywords from THIS chat, edges = co-occurrence.
  // Plus active KAI Computer projects as special nodes.
  if(!current) return;

  // 1. Extract concepts from this chat's messages
  // Strategy: tokenize words, filter stopwords + short words, weight by frequency + rarity
  const STOP = new Set(("the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is am are was were has had been being can't cant don't dont won't wont yes ok okk yh yep ye lol hmm hey hi hello bye hr min sec hrs mins secs am pm yeah nope sure haha lmao").split(" "));
  const concepts = new Map(); // word -> {count, msgIndices}
  const docCount = (current.msgs||[]).length;
  (current.msgs||[]).forEach((m, i)=>{
    const text = (m.text || '').toLowerCase();
    if(!text) return;
    // tokenize: letters only, length >= 4
    const seen_in_msg = new Set();
    const tokens = text.match(/[a-z][a-z']{3,}/g) || [];
    tokens.forEach(w=>{
      if(STOP.has(w)) return;
      if(w.length > 18) return;
      if(seen_in_msg.has(w)) return;
      seen_in_msg.add(w);
      if(!concepts.has(w)) concepts.set(w, {count:0, msgIndices:new Set()});
      const c = concepts.get(w);
      c.count++; c.msgIndices.add(i);
    });
    // also capture multi-word capitalized things from the original text (titles, names of things)
    const original = m.text || '';
    const caps = original.match(/\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+){0,2}/g) || [];
    caps.forEach(phrase=>{
      const key = phrase.toLowerCase();
      if(key.length < 4 || key.length > 40) return;
      if(STOP.has(key)) return;
      if(!concepts.has(key)) concepts.set(key, {count:0, msgIndices:new Set(), isPhrase:true});
      const c = concepts.get(key);
      c.count++; c.msgIndices.add(i);
    });
  });

  // 2. Score concepts: more count = bigger, but prefer concepts in recent messages
  const lastIdx = (current.msgs||[]).length - 1;
  const scored = [...concepts.entries()].map(([w,c])=>{
    const recent = Math.max(...c.msgIndices) >= Math.max(0, lastIdx-3);
    const score = c.count + (c.isPhrase?2:0) + (recent?1.5:0);
    return {word:w, count:c.count, msgIndices:c.msgIndices, score, recent, isPhrase:c.isPhrase};
  }).sort((a,b)=>b.score-a.score).slice(0, 18);  // cap at 18 nodes for readable graph

  // 3. Add active projects as special highlighted nodes
  const projects = (window.KaiComputer ? window.KaiComputer.list() : []).filter(t=>t.status==='running'||t.status==='paused').slice(0,4);

  // 4. Build nodes
  const nodes = [{id:'__chat__', label:'this chat', size:30, color:'#fff3bf'}];
  scored.forEach(s=>{
    const label = s.word.length>20 ? s.word.slice(0,18)+'…' : s.word;
    const size = Math.min(34, 14 + Math.log(1+s.count)*5);
    const color = s.recent ? '#ffd96b' : (s.isPhrase ? '#b197fc' : '#74c0fc');
    nodes.push({id:s.word, label, size, color});
  });
  projects.forEach(p=>{
    nodes.push({id:'__proj__'+p.id, label:'📁 '+p.title.slice(0,16), size:26, color:'#8ce99a'});
  });

  // 5. Build edges: co-occurrence within the same message → edge between two concepts
  const edges = [];
  const edgeSet = new Set();
  for(let i=0; i<scored.length; i++){
    for(let j=i+1; j<scored.length; j++){
      const a = scored[i], b = scored[j];
      // intersection of message indices
      let shared = 0;
      a.msgIndices.forEach(idx=>{ if(b.msgIndices.has(idx)) shared++; });
      if(shared > 0){
        const key = a.word + '|' + b.word;
        if(edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({from:a.word, to:b.word, w: 4 + shared*6});
      }
    }
  }
  // Also connect every top concept loosely to the central chat node
  scored.slice(0, 8).forEach(s=>{
    edges.push({from:'__chat__', to:s.word, w: 3});
  });
  // Connect projects to concepts they mention in title or goal
  projects.forEach(p=>{
    const ptext = ((p.title||'')+' '+(p.goal||'')).toLowerCase();
    scored.forEach(s=>{
      if(ptext.includes(s.word)){
        edges.push({from:'__proj__'+p.id, to:s.word, w:8});
      }
    });
    edges.push({from:'__chat__', to:'__proj__'+p.id, w:5});
  });

  vaultG=drawGraph($('vault'),nodes,edges,$('vaultInfo'),(n)=>{
    if(n.id==='__chat__'){ $('vaultInfo').textContent=`${scored.length} concepts in this chat, ${projects.length} active project${projects.length===1?'':'s'}.`; return; }
    if(n.id.startsWith('__proj__')){
      const pid = n.id.replace('__proj__','');
      const p = projects.find(x=>x.id===pid);
      $('vaultInfo').innerHTML = p ? `<b>📁 ${esc(p.title)}</b><br>${esc(p.goal||'').slice(0,140)}<br><span style="color:var(--dim);font-size:11px">${p.currentStep}/${p.plan.length} steps · ${p.status}</span>` : '(project gone)';
      return;
    }
    const c = concepts.get(n.id);
    if(c){
      // find first message mentioning this concept for preview
      const firstIdx = Math.min(...c.msgIndices);
      const sample = (current.msgs[firstIdx]?.text || '').slice(0,140);
      $('vaultInfo').innerHTML = `<b>${esc(n.id)}</b> · ${c.count}× <br><span style="color:var(--dim);font-size:11px">"${esc(sample)}…"</span>`;
    } else {
      $('vaultInfo').textContent = n.id;
    }
  }, '__chat__');
  $('vaultInfo').textContent = scored.length
    ? `${scored.length} concepts · ${edges.length} links · ${projects.length} project${projects.length===1?'':'s'}`
    : 'Chat is empty — concepts will appear as you talk.';
}

// ---------- API ----------
async function saveApi(){
  const key=($('apiKey').value||'').trim();
  if(!key){ $('apiStatus').innerHTML='Paste a key first, or use local only.'; return; }
  const prov=Providers.detect(key);
  if(!prov){ $('apiStatus').innerHTML='<b class="bad">Unrecognized key format.</b> Supports Anthropic (sk-ant-), Groq (gsk_), Cerebras (csk-), xAI (xai-), Fireworks (fw_), OpenRouter (sk-or-), Together (64-hex), Mistral (32-char), OpenAI (sk-…), DeepSeek (sk-…). 10 providers total.'; return; }
  $('apiStatus').innerHTML='Detected <b>'+prov+'</b> — checking…';
  let res;
  try{ res=await Providers.verify(prov,key); }catch(e){ res={ok:true,soft:true,reason:'will confirm on first message'}; }
  if(res.ok){
    // mutate the existing api object so window.__api stays in sync (don't replace the ref)
    api.provider=prov; api.key=key; window.__api=api;
    saveApiToStorage();
    setModeLabel(prov); setStatus(prov);
    if(res.soft){
      $('apiStatus').innerHTML='<b class="ok">'+prov+' connected</b> ('+res.reason+'). Memory stays local.';
    } else {
      $('apiStatus').innerHTML='<b class="ok">'+prov+' connected & verified.</b> Memory stays local.';
    }
  } else {
    $('apiStatus').innerHTML='<b class="bad">'+prov+': '+res.reason+'</b> — check the key, or use local.';
  }
}
function clearApi(){
  api.provider=null; api.key=null; window.__api=api;
  try{ localStorage.removeItem('kai_api'); }catch(e){}
  setModeLabel(null);
  $('apiStatus').innerHTML='Currently: <b class="ok">Local mode</b>'; $('apiKey').value='';
}
function setModeLabel(prov){
  $('modeLabel').textContent=prov?prov.toUpperCase():'LOCAL';
  $('modepill').innerHTML=prov?`brain: <b>${prov}</b> · memory: your 527k messages (local)`:'brain: <b>local</b> · memory: your 527k messages';
}

// ---------- panels ----------
function closeAll(){['scrimL','panelL','scrimR','panelR','scrimApi','panelApi','scrimG','panelG','scrimW','panelW','scrimGit','panelGit'].forEach(id=>$(id).classList.remove('on'));}
function openP(scrim,panel){closeAll();$(scrim).classList.add('on');$(panel).classList.add('on');}

// ---------- utils ----------
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

// ---------- events ----------
window.addEventListener('DOMContentLoaded',()=>{
  $('btnLeft').onclick=()=>openP('scrimL','panelL');
  $('btnRight').onclick=()=>{openP('scrimR','panelR');setTimeout(()=>vaultG&&vaultG.redraw(),360);};
  $('scrimL').onclick=closeAll;$('scrimR').onclick=closeAll;$('scrimApi').onclick=closeAll;$('scrimG').onclick=closeAll;
  $('newChat').onclick=newChat;
  $('openFullGraph').onclick=()=>{openP('scrimG','panelG');setTimeout(()=>fullG&&fullG.redraw(),360);};
  $('gClose').onclick=closeAll;
  $('openApi').onclick=()=>{openP('scrimApi','panelApi');
    $('apiStatus').innerHTML=api.provider?`Currently: <b class="ok">${api.provider}</b>`:'Currently: <b class="ok">Local mode</b>';};
  $('apiBack').onclick=closeAll;$('apiSave').onclick=saveApi;$('apiClear').onclick=clearApi;
  function wcRenderList(){
    const all = KaiComputer.list();
    const html = all.length ? all.map(t=>{
      const dot = t.status==='running'?'<span style="color:#8ce99a">●</span>':
                  t.status==='done'?'<span style="color:#5c7cfa">✓</span>':
                  t.status==='paused'?'<span style="color:#fab005">‖</span>':
                  t.status==='error'?'<span style="color:#ff8787">!</span>':'<span style="color:#666">○</span>';
      return `<div class="row wcRow" data-id="${t.id}" style="padding:8px 10px;cursor:pointer;border-radius:6px;font-size:13px">
        ${dot} <b>${esc(t.title)}</b><br>
        <span style="color:var(--dim);font-size:11px">${t.currentStep}/${t.plan.length} steps · ${t.status}</span>
      </div>`;
    }).join('') : '<div style="padding:14px;color:var(--dim);font-size:12px">No projects yet.</div>';
    $('wcList').innerHTML = html;
    document.querySelectorAll('.wcRow').forEach(el=>{
      el.onclick = ()=>{ KaiComputer.setActive(el.dataset.id); wcRenderDetail(); wcRenderList(); };
    });
  }
  function wcRenderDetail(){
    const t = KaiComputer.active();
    if(!t){ $('wcDetail').innerHTML='<div style="padding:20px;color:var(--dim);text-align:center">Select a project, or tap <b>+ New project</b>.</div>'; return; }
    const planHtml = t.plan.length ? t.plan.map((p,i)=>{
      const mark = p.status==='done'?'✓':p.status==='error'?'✕':i===t.currentStep?'→':'·';
      const color = p.status==='done'?'#8ce99a':p.status==='error'?'#ff8787':i===t.currentStep?'#ffd96b':'#888';
      return `<div style="padding:4px 0;color:${color};font-size:13px"><b>${mark}</b> ${esc(p.step)}${p.result?`<div style="font-size:11px;color:var(--dim);margin-left:18px">→ ${esc(p.result.slice(0,200))}</div>`:''}</div>`;
    }).join('') : '<i style="color:var(--dim);font-size:12px">No plan yet — give KAI the goal and he\'ll plan it.</i>';
    const files = Object.keys(t.files);
    const filesHtml = files.length ? files.map(f=>`<div style="padding:3px 0;font-family:monospace;font-size:11px;color:var(--ink)">📄 ${esc(f)} <span style="color:var(--dim)">(${(t.files[f]||'').length} chars)</span></div>`).join('') : '<i style="color:var(--dim);font-size:12px">No files yet.</i>';
    const logHtml = t.log.slice(-8).map(l=>{
      const tm = new Date(l.t).toLocaleTimeString();
      const c = l.type==='error'?'#ff8787':l.type==='step'?'#8ce99a':'#aaa';
      return `<div style="font-family:monospace;font-size:11px;color:${c}">[${tm}] ${esc(l.msg)}</div>`;
    }).join('');
    const stopBtn = (t.status==='running')?`<button class="tm-btn" id="wcStop" data-id="${t.id}" style="background:#3a2a1a">⏸ Stop</button>`:'';
    const planBtn = (t.status==='idle' && t.goal) ? `<button class="tm-btn" id="wcAskPlan" data-id="${t.id}" style="background:#1f3a1f">▶ Ask KAI to plan</button>` : '';
    const delBtn = `<button class="tm-btn" id="wcDel" data-id="${t.id}">🗑</button>`;
    $('wcDetail').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div><h4 style="margin:0">${esc(t.title)}</h4><div style="font-size:11px;color:var(--dim)">status: ${t.status} · ${t.currentStep}/${t.plan.length}</div></div>
        <div>${planBtn} ${stopBtn} ${delBtn}</div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--dim)">Goal: ${esc(t.goal||'(none)')}</div>
      <div class="sec" style="margin-top:14px">Plan</div>
      ${planHtml}
      <div class="sec" style="margin-top:14px">Files (${files.length})</div>
      ${filesHtml}
      <div class="sec" style="margin-top:14px">Log</div>
      <div style="background:#000;padding:6px 8px;border-radius:6px;max-height:140px;overflow-y:auto">${logHtml||'<i style="color:#666;font-size:11px">no activity</i>'}</div>
    `;
    const stop = document.getElementById('wcStop');
    if(stop) stop.onclick = ()=>{ KaiComputer.stop(stop.dataset.id); wcRenderDetail(); wcRenderList(); };
    const askPlan = document.getElementById('wcAskPlan');
    if(askPlan) askPlan.onclick = ()=>{
      const proj = KaiComputer.get(askPlan.dataset.id);
      if(!proj) return;
      closeAll();
      // Inject a message into chat asking KAI to plan it
      $('input').value = `Plan and run this project for me. Use project_plan with the right steps, then start executing.\n\nProject: ${proj.title}\nID: ${proj.id}\nGoal: ${proj.goal}`;
      $('input').focus();
    };
    const del = document.getElementById('wcDel');
    if(del) del.onclick = ()=>{ if(confirm('Delete this project?')){ KaiComputer.remove(del.dataset.id); wcRenderDetail(); wcRenderList(); } };
  }
  $('openWorkspace').onclick=()=>{
    openP('scrimW','panelW');
    wcRenderList();
    wcRenderDetail();
  };
  $('wcClose').onclick=closeAll;
  $('wcNew').onclick=()=>{
    const title = prompt('Project name?'); if(!title) return;
    const goal = prompt('Goal (what should KAI accomplish)?')||'';
    const t = KaiComputer.newTask(title, goal);
    wcRenderList(); wcRenderDetail();
    // If they gave a goal, offer to start KAI on it
    if(goal && api.key && confirm('Ask KAI to plan and run this now?')){
      closeAll();
      $('input').value = `Plan and run this project for me. Use project_plan with the right steps, then start executing.\n\nProject: ${t.title}\nID: ${t.id}\nGoal: ${t.goal}`;
      $('input').focus();
    }
  };
  // Live updates — when KaiComputer fires events, refresh the UI if open
  KaiComputer.on((kind, task)=>{
    if(document.getElementById('panelW')?.classList.contains('open')){
      wcRenderList(); if(task && task.id === (KaiComputer.active()?.id)) wcRenderDetail();
    }
  });
  // Start the background ticker so detached tasks keep running
  KaiComputer.startTicker();
  $('wClose').onclick=closeAll;
  $('scrimW').onclick=closeAll;
  $('openGit').onclick=()=>{
    openP('scrimGit','panelGit');
    const info=KaiGitHub.info();
    $('gitStatus').innerHTML = info.connected
      ? '<b class="ok">Connected</b> as '+esc(info.user)+' → '+esc(info.owner)+'/'+esc(info.repo)
      : 'Not connected.';
  };
  $('gitBack').onclick=closeAll;
  $('scrimGit').onclick=closeAll;
  $('gitSave').onclick=async ()=>{
    const tok=($('gitTok').value||'').trim();
    const rep=($('gitRepo').value||'luokai25/kai_app').trim();
    if(!tok){ $('gitStatus').innerHTML='<b class="bad">Paste a token first.</b>'; return; }
    const [own,rp]=rep.includes('/')?rep.split('/'):[null,null];
    if(!own||!rp){ $('gitStatus').innerHTML='<b class="bad">Repo must be owner/name</b>'; return; }
    $('gitStatus').innerHTML='Verifying token & repo access...';
    try{
      const r=await KaiGitHub.connect(tok,own,rp);
      $('gitStatus').innerHTML='<b class="ok">Connected</b> as '+esc(r.user)+' → '+esc(r.owner)+'/'+esc(r.repo)+' · KAI can now evolve.';
      $('gitTok').value='';
    }catch(e){ $('gitStatus').innerHTML='<b class="bad">'+esc(e.message)+'</b>'; }
  };
  $('gitClear').onclick=()=>{ KaiGitHub.clear(); $('gitStatus').innerHTML='Disconnected.'; };
  $('openAbout').onclick=()=>{closeAll();alert('KAI — an AI built from Luo Kai\'s own messages across WhatsApp, Instagram, and Snapchat. His reflection and companion. Local-first; optional API for sharper wording, but memory is always yours.');};
  $('send').onclick=send;
  $('mic').onclick=()=>{
    if(!KaiSpeech.available()){ alert('Voice input needs mic permission / a newer Android WebView.'); return; }
    $('mic').textContent='●';
    KaiSpeech.listen((text,err)=>{
      $('mic').textContent='🎤';
      if(err){ return; }
      if(text){ $('input').value=text; send(); }
    });
  };
  $('toggleVoice').onclick=()=>{ const on=KaiSpeech.toggleVoiceOut(); $('voiceState').textContent=on?'on':'off'; };
  $('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
  $('input').addEventListener('input',function(){this.style.height='44px';this.style.height=Math.min(120,this.scrollHeight)+'px';});
  boot();
});


// =========== AMBIENT THINKING ===========
// Runs every N minutes. KAI scans his world, decides if anything is worth telling Kai.
async function ambientThink(){
  if(!READY || !api.key || !api.provider) return; // need brain
  const goals = (window.KaiGoals?.active()||[]).slice(0,5);
  const recentTools = (window.KaiWorkspace?.getRecentToolLog(5)||[]);
  const selfNotes = (window.KaiWorkspace?.getSelfNotes()||[]).slice(-5);
  // Don't ping more than once per 2 hours
  const lastPing = parseInt(localStorage.getItem('kai_last_ping')||'0');
  const since = Date.now()-lastPing;
  if(since < 2*60*60*1000) return; // 2 hr cooldown

  const ctx = `Ambient check. Time: ${new Date().toLocaleString()}.
Active goals: ${goals.map(g=>g.title+' ('+Math.round(g.progress*100)+'%)').join('; ')||'none'}
Recent self-notes: ${selfNotes.join('; ')||'none'}

Decide: is there anything Kai should be reminded of, encouraged about, or told right now? Be quiet unless it's truly worth interrupting. Respond ONLY in JSON: {"notify":true|false,"title":"...","message":"..."} — no other text.`;
  try{
    const out = await Providers.chat(api.provider, api.key,
      [{role:'user',content:ctx}],
      'You are KAI in ambient mode. Be sparing — only notify if it genuinely helps Kai.');
    const m = out.match(/\{[\s\S]*\}/);
    if(m){
      let j=null; try{ j=JSON.parse(m[0]); }catch(e){}
      if(j && j.notify && j.title){
        await KaiBackground.notify(j.title, j.message||'');
        localStorage.setItem('kai_last_ping', String(Date.now()));
        // also log it in workspace
        if(window.KaiWorkspace?.getSelfNotes) {
          // memory of having pinged
          try{ const k=JSON.parse(localStorage.getItem('kai_pings')||'[]'); k.push({t:Date.now(),title:j.title,msg:j.message}); if(k.length>30) k.shift(); localStorage.setItem('kai_pings',JSON.stringify(k)); }catch(e){}
        }
      }
    }
  }catch(e){ console.warn('ambient err',e); }
}
