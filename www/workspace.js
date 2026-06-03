// KAI Workspace — KAI's hands and inner world.
// He can run code, fetch the web, write his own notes/scratchpad, remember across sessions.
// When the API brain is on, the model CHOOSES tools; without it, intent fallback still works.
window.KaiWorkspace = (function(){

  // --- Persistent inner workspace (KAI's own scratchpad + self-notes) ---
  function _load(k,d){ try{ return JSON.parse(localStorage.getItem(k)||JSON.stringify(d)); }catch(e){ return d; } }
  function _save(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
  let SCRATCH = _load('kai_scratch', {}); // {name: text}
  let SELFNOTES = _load('kai_selfnotes', []); // ["learned X about Kai", ...]
  let TOOLLOG = _load('kai_toollog', []); // history of what he did

  function logTool(t,input,output,ok){
    TOOLLOG.push({t:Date.now(), tool:t, input:String(input).slice(0,200), output:String(output).slice(0,300), ok});
    if(TOOLLOG.length>200) TOOLLOG.shift();
    _save('kai_toollog', TOOLLOG);
  }

  // --- The tools KAI can wield ---
  const TOOLS = {
    run_code: {
      desc: "Execute JavaScript in the app to compute, transform data, or solve problems. Returns the result.",
      params: {code: "JS code to run; the last expression is returned"},
      run: async ({code}) => {
        try{
          // sandboxed-ish eval — has access to KaiVoice for memory queries
          const fn = new Function('KaiVoice','KaiWorkspace', `return (async()=>{ ${code} })();`);
          const r = await fn(window.KaiVoice, window.KaiWorkspace);
          return { ok:true, result: typeof r==='object'?JSON.stringify(r):String(r) };
        }catch(e){ return { ok:false, result: 'error: '+e.message }; }
      }
    },
    web_fetch: {
      desc: "Fetch a URL and return its text content. For live info, articles, APIs.",
      params: {url: "https URL to fetch"},
      run: async ({url}) => {
        try{
          // use a CORS-tolerant proxy for arbitrary sites
          const proxied = "https://r.jina.ai/" + url;
          const r = await fetch(proxied);
          const text = (await r.text()).slice(0,4000);
          return { ok:true, result: text };
        }catch(e){ return { ok:false, result: 'fetch failed: '+e.message }; }
      }
    },
    web_search: {
      desc: "Search the web for current info. Returns short summary + links.",
      params: {query: "search query"},
      run: async ({query}) => {
        try{
          const r = await fetch('https://api.duckduckgo.com/?q='+encodeURIComponent(query)+'&format=json&no_html=1');
          const d = await r.json();
          const ans = d.AbstractText || d.Answer || '';
          const rel = (d.RelatedTopics||[]).filter(x=>x.Text).slice(0,4).map(x=>x.Text).join("\n• ");
          return { ok:true, result: (ans?ans+"\n\n":"")+(rel?"• "+rel:""), url:'https://duckduckgo.com/?q='+encodeURIComponent(query) };
        }catch(e){ return { ok:false, result: 'search failed: '+e.message }; }
      }
    },
    memory_recall: {
      desc: "Search Kai's own message history for relevant memories. Use to ground answers in his real past.",
      params: {query: "what to look up", person: "(optional) specific person to focus on"},
      run: async ({query, person}) => {
        if(!window.KaiVoice) return { ok:false, result:'memory not ready' };
        const mem = window.KaiVoice.recall(query, person||null, 8);
        if(!mem.length) return { ok:true, result:'(no specific memories found)' };
        return { ok:true, result: mem.map(m=>`[${m.date||'?'}] ${m.kai?'Kai':(m.person||'them')}: ${m.text}`).join("\n") };
      }
    },
    scratchpad_write: {
      desc: "Save text to a named scratchpad slot for later. Use to remember work in progress, drafts, plans.",
      params: {name: "slot name", text: "content to save"},
      run: async ({name, text}) => {
        SCRATCH[name] = text; _save('kai_scratch', SCRATCH);
        return { ok:true, result: `saved to scratch:${name} (${text.length} chars)` };
      }
    },
    scratchpad_read: {
      desc: "Read a previously saved scratchpad slot, or list all slot names if none given.",
      params: {name: "(optional) slot to read"},
      run: async ({name}) => {
        if(!name) return { ok:true, result: 'slots: '+Object.keys(SCRATCH).join(', ') };
        return { ok:true, result: SCRATCH[name] || '(empty)' };
      }
    },
    remember_about_kai: {
      desc: "Save something KAI just learned about Kai that should persist across all future chats.",
      params: {fact: "the fact to remember"},
      run: async ({fact}) => {
        if(!fact) return { ok:false, result:'no fact given' };
        if(!SELFNOTES.includes(fact)){ SELFNOTES.push(fact); if(SELFNOTES.length>200) SELFNOTES.shift(); _save('kai_selfnotes', SELFNOTES); }
        return { ok:true, result: 'remembered ('+SELFNOTES.length+' total)' };
      }
    },
    find_skill: {
      desc: "Search KAI's skill library (9,786 expert skills across coding, science, business, AI, math, etc.) to find skills relevant to the task. Returns top matches.",
      params: {query: "what kind of skill is needed"},
      run: async ({query}) => {
        if(!window.KaiSkills || !window.KaiSkills.ready()) return { ok:false, result:'skills not loaded' };
        const hits = window.KaiSkills.search(query, 5);
        if(!hits.length) return { ok:true, result:'(no matching skills)' };
        return { ok:true, result: hits.map(h=>'• '+h.name+' ['+h.category+']: '+h.description).join("\n") };
      }
    },
    load_skill: {
      desc: "Load a specific skill's full instructions to follow it. Use after find_skill to read the skill content.",
      params: {name: "exact skill name from find_skill"},
      run: async ({name}) => {
        if(!window.KaiSkills || !window.KaiSkills.ready()) return { ok:false, result:'skills not loaded' };
        const sk = window.KaiSkills.load(name);
        if(!sk) return { ok:false, result:'skill not found: '+name };
        return { ok:true, result: '# '+sk.name+'\n'+sk.description+'\n\n'+sk.body.slice(0,3500) };
      }
    },
    knowledge_lookup: {
      desc: "Search KAI's curated knowledge (28k entries: practical assist, world facts, math reasoning). Use for help when memory isn't enough.",
      params: {query: "what to look up", pillar: "(optional) assist | world | reason"},
      run: async ({query, pillar}) => {
        if(!window.KAI_KNOWLEDGE) return { ok:false, result:'knowledge not loaded' };
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return { ok:true, result:'(empty query)' };
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const pf = pillar ? " AND pillar='"+pillar.replace(/'/g,"")+"'" : '';
          const r=window.KAI_KNOWLEDGE.exec("SELECT pillar,cat,q,a FROM know WHERE "+like+pf+" LIMIT 3");
          if(!r[0]) return { ok:true, result:'(no match)' };
          const out = r[0].values.map(v=>'['+v[0]+'/'+v[1]+'] Q: '+v[2].slice(0,150)+'\nA: '+v[3].slice(0,400)).join("\n\n");
          return { ok:true, result: out };
        }catch(e){ return { ok:false, result:'lookup failed: '+e.message }; }
      }
    },
    play_song: {
      desc: "Find and play a song. Embeds a player in the chat.",
      params: {query: "song name/artist/description"},
      run: async ({query}) => {
        if(!window.KaiTools) return { ok:false, result:'tools not loaded' };
        const r = await window.KaiTools.run({tool:'music', q:query});
        return { ok:!!r, result: r?.say||'started', html: r?.html };
      }
    },
    open_app: {
      desc: "Open an app on the user's device (maps, youtube, spotify, whatsapp, instagram).",
      params: {app: "app name"},
      run: async ({app}) => {
        const r = window.KaiTools.run({tool:'open', q:'open '+app});
        return { ok:true, result: (await r).say };
      }
    },
  };

  // What KAI knows about (for the API prompt)
  function toolDescriptions(){
    return Object.entries(TOOLS).map(([name,t])=>{
      const params = Object.entries(t.params).map(([k,v])=>`${k}: ${v}`).join("; ");
      return `- ${name}(${params}): ${t.desc}`;
    }).join("\n");
  }

  // Execute a tool by name + args (the brain calls this)
  async function exec(name, args){
    const t = TOOLS[name];
    if(!t) { logTool(name,args,'unknown tool',false); return { ok:false, result:'unknown tool: '+name }; }
    try{
      const r = await t.run(args||{});
      logTool(name, JSON.stringify(args||{}), r.result, r.ok);
      return r;
    }catch(e){
      logTool(name, JSON.stringify(args||{}), e.message, false);
      return { ok:false, result: 'tool error: '+e.message };
    }
  }

  function getSelfNotes(){ return SELFNOTES.slice(); }
  function getRecentToolLog(n){ return TOOLLOG.slice(-(n||10)); }

  return { TOOLS, exec, toolDescriptions, getSelfNotes, getRecentToolLog };
})();
