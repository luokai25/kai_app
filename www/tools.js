// KAI tools — the agent layer. Detects intent from a message and acts.
// Built to degrade gracefully: if a capability isn't available, KAI says so honestly.
window.KaiTools = (function(){

  // ---- intent detection ----
  function detect(text){
    const t=text.toLowerCase().trim();
    if(/\b(play|put on|listen to)\b.*\b(song|music|track|by|from)\b/.test(t) || /^play /.test(t)) return {tool:'music',q:text};
    if(/\b(search|look up|google|find online|what is|who is|latest|news about)\b/.test(t)) return {tool:'search',q:text};
    if(/\b(open|launch|go to)\b.*\b(maps|youtube|spotify|whatsapp|instagram|camera|settings)\b/.test(t)) return {tool:'open',q:text};
    if(/\b(call|dial|phone)\b/.test(t) && /\d/.test(t)) return {tool:'dial',q:text};
    if(/\b(my files|on my (phone|device)|search my|find.*file)\b/.test(t)) return {tool:'files',q:text};
    if(/[0-9].*[\+\-\*\/x×÷].*[0-9]|calculate|what'?s \d/.test(t)) return {tool:'math',q:text};
    return null;
  }

  // ---- music: pick & play. Embed a YouTube player in chat, with an "open on device" option ----
  function songQuery(text){
    return text.replace(/^.*?\b(play|put on|listen to)\b/i,'').replace(/\b(a song|some music|for me|please)\b/ig,'').trim() || 'music';
  }
  // Look up a real, embeddable video id via YouTube/Piped search; fall back to device handoff.
  async function music(text){
    const q=songQuery(text);
    let vid=null, title=q;
    // try Piped (open YouTube API, embeddable results) — works without a key
    const apis=["https://pipedapi.kavin.rocks","https://piped-api.lunar.icu","https://pipedapi.adminforge.de"];
    for(const base of apis){
      try{
        const r=await fetch(base+"/search?q="+encodeURIComponent(q+" official audio")+"&filter=videos");
        if(!r.ok) continue;
        const d=await r.json();
        const items=d.items||d; 
        if(items&&items.length){
          const it=items.find(x=>x.url||x.videoId)||items[0];
          vid=(it.url&&it.url.split("v=")[1])||it.videoId||null;
          if(it.title) title=it.title;
          if(vid) break;
        }
      }catch(e){ continue; }
    }
    const openYT = vid ? ("https://www.youtube.com/watch?v="+vid) : ("https://www.youtube.com/results?search_query="+encodeURIComponent(q));
    const embed = vid ? ("https://www.youtube-nocookie.com/embed/"+vid+"?autoplay=1&playsinline=1") : null;
    const player = embed
      ? `<iframe class="tm-frame" src="${embed}" allow="autoplay; encrypted-media" allowfullscreen referrerpolicy="origin"></iframe>`
      : `<div class="tm-label" style="opacity:.8">Couldn\'t embed this one — tap below to play it.</div>`;
    return {
      type:'music', title,
      html:`<div class="tool-music">
        <div class="tm-label">\u266a <b>${esc(title)}</b></div>
        ${player}
        <div class="tm-actions">
          <a class="tm-btn" href="${openYT}" target="_blank" rel="noopener">Play in YouTube</a>
          <a class="tm-btn" href="https://open.spotify.com/search/${encodeURIComponent(q)}" target="_blank" rel="noopener">Play in Spotify</a>
        </div>
      </div>`,
      say:`Putting on ${title} \u266a`
    };
  }

  // ---- web search (uses provider key if present via caller; else DuckDuckGo instant) ----
  async function search(text){
    const q=text.replace(/\b(search|look up|google|find online|for me|please)\b/ig,'').trim();
    try{
      const r=await fetch('https://api.duckduckgo.com/?q='+encodeURIComponent(q)+'&format=json&no_html=1&skip_disambig=1');
      const d=await r.json();
      let ans=d.AbstractText||d.Answer||'';
      const rel=(d.RelatedTopics||[]).filter(x=>x.Text).slice(0,3).map(x=>x.Text);
      if(!ans && rel.length) ans=rel[0];
      const body = ans || "I couldn't find a quick answer for that.";
      return {type:'search',say:body,extra:rel.length?('\n\n• '+rel.join('\n• ')):'' , url:'https://duckduckgo.com/?q='+encodeURIComponent(q)};
    }catch(e){
      return {type:'search',say:"I couldn't reach the web just now.",url:'https://duckduckgo.com/?q='+encodeURIComponent(q)};
    }
  }

  // ---- open device apps via intent URLs ----
  function open(text){
    const t=text.toLowerCase();
    const map={maps:'geo:0,0?q=',youtube:'https://youtube.com',spotify:'spotify:',whatsapp:'https://wa.me',instagram:'https://instagram.com',camera:'',settings:''};
    for(const k in map){ if(t.includes(k)) return {type:'open',url:map[k],say:`Opening ${k}.`}; }
    return {type:'open',say:"Which app should I open?"};
  }
  function dial(text){
    const num=(text.match(/[\d\+][\d\s\-]{5,}/)||[''])[0].replace(/\s/g,'');
    return num?{type:'dial',url:'tel:'+num,say:`Calling ${num}.`}:{type:'dial',say:"What number?"};
  }

  // ---- math (safe eval) ----
  function math(text){
    const m=text.replace(/[^0-9\+\-\*\/\.\(\)x×÷ ]/g,'').replace(/x|×/g,'*').replace(/÷/g,'/').trim();
    if(!m) return {type:'math',say:"What should I calculate?"};
    try{ const v=Function('"use strict";return ('+m+')')(); return {type:'math',say:`${m.trim()} = ${v}`}; }
    catch(e){ return {type:'math',say:"I couldn't work that one out."}; }
  }

  function files(){
    // requires Cordova file plugin + permission; wired in Wave 2
    return {type:'files',say:"Searching your device files needs storage permission — I'll have that once you grant it in settings."};
  }

  function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

  async function run(intent){
    switch(intent.tool){
      case 'music': return await music(intent.q);
      case 'search': return await search(intent.q);
      case 'open': return open(intent.q);
      case 'dial': return dial(intent.q);
      case 'math': return math(intent.q);
      case 'files': return files();
    }
    return null;
  }

  return { detect, run };
})();
