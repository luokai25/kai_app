// KAI app — fused chat + graphs, local/API hybrid brain.
const $=id=>document.getElementById(id);
// WebView-safe local loaders: fetch() is unreliable on file:// in Android WebView.
function xhrBuffer(url){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('GET',url,true);x.responseType='arraybuffer';x.onload=()=>{if(x.status===0||x.status===200)res(x.response);else rej(new Error('xhr '+x.status));};x.onerror=()=>rej(new Error('xhr error '+url));x.send();});}
function xhrJSON(url){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('GET',url,true);x.onload=()=>{try{res(JSON.parse(x.responseText));}catch(e){rej(e);}};x.onerror=()=>rej(new Error('xhr error '+url));x.send();});}
let DB=null, PROFILE=null, GRAPH=null;
let chats=[], current=null;            // chats: {id,title,msgs:[{role,text}],vault:Set(person)}
let api={provider:null,key:null};
let MEMORY=[];  // persistent cross-chat memory (facts KAI keeps)
function loadMem(){ try{ MEMORY=JSON.parse(localStorage.getItem('kai_memory')||'[]'); }catch(e){ MEMORY=[]; } }
function rememberFact(f){ if(f&&!MEMORY.includes(f)){ MEMORY.push(f); if(MEMORY.length>200)MEMORY.shift(); try{localStorage.setItem('kai_memory',JSON.stringify(MEMORY));}catch(e){} } }      // active API (null = local)

// ---------- storage (in-memory + localStorage for chats/api) ----------
function save(){ try{
  localStorage.setItem('kai_chats',JSON.stringify(chats.map(c=>({id:c.id,title:c.title,msgs:c.msgs,vault:[...c.vault]}))));
  localStorage.setItem('kai_api',JSON.stringify(api));
}catch(e){} }
function load(){ try{
  const c=JSON.parse(localStorage.getItem('kai_chats')||'[]');
  chats=c.map(x=>({...x,vault:new Set(x.vault||[])}));
  const a=JSON.parse(localStorage.getItem('kai_api')||'null'); if(a&&a.key){api=a;}
}catch(e){chats=[];} }

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
    // Load KAI's assistant knowledge pack (6,953 HF curated Q&A)
    try{
      let kbytes;
      try{ kbytes=new Uint8Array(await xhrBuffer('kai_knowledge.db')); }
      catch(e){ const gz=new Uint8Array(await xhrBuffer('kai_knowledge.db.gz')); kbytes=pako.ungzip(gz); }
      window.KAI_KNOWLEDGE=new SQL.Database(kbytes);
      console.log('KAI knowledge loaded');
    }catch(e){ console.warn('knowledge load failed',e); }
    // Load KAI's skill library (9,786 Claude-style skills)
    try{
      let sbytes;
      try{ sbytes=new Uint8Array(await xhrBuffer('kai_skills.db')); }
      catch(e){ const gz=new Uint8Array(await xhrBuffer('kai_skills.db.gz')); sbytes=pako.ungzip(gz); }
      const sdb=new SQL.Database(sbytes);
      window.KAI_SKILLS_DB = sdb;  // exposed so add_skill can write
      KaiSkills.init(sdb);
      console.log('KAI skills loaded:', KaiSkills.stats());
    }catch(e){ console.warn('skills load failed',e); }
    READY=true;
    if(api.key&&api.provider) setModeLabel(api.provider);
    renderChatList();
    setStatus(api.provider?api.provider:'local');
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
        +'\n\nYou have a workspace and you can EVOLVE YOURSELF. Soft layers (skills, theme, self-notes, lessons) — change live via tools. Code/UI changes — use github_propose_fix to open a PR Kai approves; CI builds your next APK. If something errors, use log_error_lesson so future-you avoids it. Be bold but careful: skills/theme/notes are reversible, code changes flow through PR review. Stay brief, act when it helps, ask when uncertain.';
      // chat history (recent turns)
      const hist=current.msgs.filter(m=>!m._t).slice(-8).map(m=>({role:m.role==='me'?'user':'assistant',content:m.text||''}));
      hist.push({role:'user',content:text});
      const out=await Providers.agenticChat(api.provider,api.key,hist,sys,KaiWorkspace.TOOLS,(n,a)=>KaiWorkspace.exec(n,a));
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
  if(!current) return;
  const people=[...current.vault];
  const nodes=[{id:'Kai',label:'Kai',size:36,color:'#fff3bf'}].concat(
    people.map(p=>{const n=(GRAPH.nodes||[]).find(x=>x.id===p)||{};return{id:p,label:p,size:n.size?Math.min(40,n.size*0.6):22,color:n.color||'#74c0fc'};}));
  const edges=people.map(p=>({from:'Kai',to:p,w:20}));
  vaultG=drawGraph($('vault'),nodes,edges,$('vaultInfo'),(n)=>{
    if(n.id==='Kai'){$('vaultInfo').textContent='Kai — this conversation.';return;}
    const mem=KaiVoice.memoriesWith(n.id,1)[0];
    $('vaultInfo').innerHTML=`<b>${n.id}</b>${mem?'<br>"'+esc(mem.text.slice(0,80))+'"':''}`;
  });
  $('vaultInfo').textContent=people.length?`${people.length} ${people.length===1?'person':'people'} touched in this chat.`:'No one mentioned yet — this chat\'s vault grows as you talk.';
}

// ---------- API ----------
async function saveApi(){
  const key=($('apiKey').value||'').trim();
  if(!key){ $('apiStatus').innerHTML='Paste a key first, or use local only.'; return; }
  const prov=Providers.detect(key);
  if(!prov){ $('apiStatus').innerHTML='<b class="bad">Unrecognized key format.</b> Expected sk-ant- / gsk_ / sk- / 32-char Mistral.'; return; }
  $('apiStatus').innerHTML='Detected <b>'+prov+'</b> — checking…';
  let res;
  try{ res=await Providers.verify(prov,key); }catch(e){ res={ok:true,soft:true,reason:'will confirm on first message'}; }
  if(res.ok){
    api={provider:prov,key}; save(); setModeLabel(prov); setStatus(prov);
    if(res.soft){
      $('apiStatus').innerHTML='<b class="ok">'+prov+' connected</b> ('+res.reason+'). Memory stays local.';
    } else {
      $('apiStatus').innerHTML='<b class="ok">'+prov+' connected & verified.</b> Memory stays local.';
    }
  } else {
    $('apiStatus').innerHTML='<b class="bad">'+prov+': '+res.reason+'</b> — check the key, or use local.';
  }
}
function clearApi(){ api={provider:null,key:null}; save(); setModeLabel(null);
  $('apiStatus').innerHTML='Currently: <b class="ok">Local mode</b>'; $('apiKey').value='';}
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
  $('openWorkspace').onclick=()=>{
    openP('scrimW','panelW');
    // populate
    const sn=KaiWorkspace.getSelfNotes();
    $('wSelfNotes').innerHTML = sn.length ? sn.map(n=>'• '+esc(n)).join('<br>') : '<i style="color:var(--dim)">Nothing yet — KAI will note things as you talk.</i>';
    const log=KaiWorkspace.getRecentToolLog(15);
    $('wToolLog').innerHTML = log.length ? log.map(l=>{
      const d=new Date(l.t).toLocaleTimeString();
      return `[${d}] <b style="color:${l.ok?'#8ce99a':'#ff8787'}">${esc(l.tool)}</b> → ${esc(l.output.slice(0,80))}`;
    }).join('<br>') : '<i style="color:var(--dim)">No actions yet — give KAI something to do.</i>';
    const tools = Object.entries(KaiWorkspace.TOOLS).map(([n,t])=>`<b style="color:var(--gold)">${n}</b> — ${esc(t.desc)}`).join('<br>');
    $('wTools').innerHTML = tools;
    $('wScratch').innerHTML='<i style="color:var(--dim)">Slots appear here as KAI uses them.</i>';
  };
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
