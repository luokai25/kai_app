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
    // ---- 6 KNOWLEDGE PILLARS (410k entries) ----
    code_lookup: {
      desc: "Search code knowledge (200k entries: python, javascript, sql, java, html, cpp, etc.). Top tool for any coding task.",
      params: {query:"code task", lang:"(optional) python|javascript|sql|java|html|cpp|go|rust"},
      run: async ({query,lang})=>{
        if(!window.KAI_CODE) return {ok:false,result:'code DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,5);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const lf = lang ? " AND lang='"+lang.replace(/'/g,"")+"'" : '';
          const r=window.KAI_CODE.exec("SELECT lang,q,a FROM code WHERE "+like+lf+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\n# '+v[1].slice(0,200)+'\n\n'+v[2].slice(0,1200)).join("\n\n---\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    reasoning_lookup: {
      desc: "Search reasoning/math knowledge (40k step-by-step problems: gsm8k, metamath, open-platypus). Use for math, logic, multi-step thinking.",
      params: {query:"problem or topic"},
      run: async ({query})=>{
        if(!window.KAI_REASON) return {ok:false,result:'reasoning DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const r=window.KAI_REASON.exec("SELECT kind,q,a FROM reason WHERE "+like+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\nQ: '+v[1].slice(0,200)+'\nA: '+v[2].slice(0,1000)).join("\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    writing_lookup: {
      desc: "Search writing/communication knowledge (40k examples: drafts, summaries, brainstorms, helpful responses). Use for writing tasks.",
      params: {query:"writing task"},
      run: async ({query})=>{
        if(!window.KAI_WRITE) return {ok:false,result:'writing DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const r=window.KAI_WRITE.exec("SELECT kind,q,a FROM write WHERE "+like+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\nQ: '+v[1].slice(0,200)+'\nA: '+v[2].slice(0,1500)).join("\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    research_lookup: {
      desc: "Search research/world knowledge (80k: science, trivia, facts, wikipedia-style). Use for factual questions, learning, looking things up.",
      params: {query:"question or topic"},
      run: async ({query})=>{
        if(!window.KAI_RESEARCH) return {ok:false,result:'research DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const r=window.KAI_RESEARCH.exec("SELECT src,q,a FROM research WHERE "+like+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\nQ: '+v[1].slice(0,200)+'\nA: '+v[2].slice(0,1500)).join("\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    productivity_lookup: {
      desc: "Search productivity/planning knowledge (20k: how-to, plans, strategies, instruction following). Use for planning, life admin, getting things done.",
      params: {query:"task or situation"},
      run: async ({query})=>{
        if(!window.KAI_PROD) return {ok:false,result:'productivity DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const r=window.KAI_PROD.exec("SELECT src,q,a FROM prod WHERE "+like+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\nQ: '+v[1].slice(0,200)+'\nA: '+v[2].slice(0,1500)).join("\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    chat_lookup: {
      desc: "Search conversational knowledge (30k high-quality chat exchanges). Use for natural conversation patterns and how an assistant should respond.",
      params: {query:"conversation topic"},
      run: async ({query})=>{
        if(!window.KAI_CHAT) return {ok:false,result:'chat DB not loaded'};
        try{
          const qs=(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,4);
          if(!qs.length) return {ok:true,result:'(empty)'};
          const like=qs.map(w=>"(q LIKE '%"+w.replace(/'/g,"")+"%' OR a LIKE '%"+w.replace(/'/g,"")+"%')").join(" AND ");
          const r=window.KAI_CHAT.exec("SELECT src,q,a FROM chat WHERE "+like+" LIMIT 3");
          if(!r[0]) return {ok:true,result:'(no match)'};
          return {ok:true,result:r[0].values.map(v=>'['+v[0]+']\nQ: '+v[1].slice(0,200)+'\nA: '+v[2].slice(0,1500)).join("\n\n")};
        }catch(e){return {ok:false,result:'lookup failed: '+e.message};}
      }
    },
    // ---- KAI COMPUTER: detached projects ----
    project_create: {
      desc: "Create a new long-running project that persists across chats. Use for multi-step work (build a website, research a topic deeply, write a long doc, code a feature). The project keeps running in the background after this reply ends.",
      params: {title:"short project name", goal:"what to accomplish in detail"},
      run: async ({title, goal})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        const t = window.KaiComputer.newTask(title, goal);
        return {ok:true, result:'project created: '+t.id+' ("'+t.title+'"). Use project_plan next to lay out steps.'};
      }
    },
    project_plan: {
      desc: "Set the plan (ordered steps) for a project. Each step should be small and concrete. After this, the project will start executing in background.",
      params: {id:"project id", steps:"JSON array of step descriptions, e.g. [\"research X\",\"write outline\",\"draft section 1\"]"},
      run: async ({id, steps})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        let arr=[];
        try{ arr = typeof steps==='string' ? JSON.parse(steps) : steps; }catch(e){ return {ok:false,result:'steps must be JSON array'}; }
        if(!Array.isArray(arr) || !arr.length) return {ok:false, result:'need at least one step'};
        const t = window.KaiComputer.get(id);
        if(!t) return {ok:false, result:'no such project: '+id};
        window.KaiComputer.setPlan(id, arr);
        window.KaiComputer.appendLog(id, 'plan', arr.length+' steps planned');
        return {ok:true, result:'plan set: '+arr.length+' steps. Project is now RUNNING in background — independent of this chat reply.'};
      }
    },
    project_step: {
      desc: "Execute one step of a project. Records the result and advances to the next step.",
      params: {id:"project id", result:"what was done / output of this step"},
      run: async ({id, result})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        const t = window.KaiComputer.get(id);
        if(!t) return {ok:false, result:'no such project: '+id};
        const idx = t.currentStep;
        if(idx >= t.plan.length) return {ok:true, result:'already done'};
        window.KaiComputer.markStep(id, idx, 'done', result);
        window.KaiComputer.appendLog(id, 'step', '✓ step '+(idx+1)+': '+(t.plan[idx]?.step||'').slice(0,80));
        return {ok:true, result:'step '+(idx+1)+'/'+t.plan.length+' done'};
      }
    },
    project_file_write: {
      desc: "Write a file in the project workspace. Creates or overwrites. Files persist with the project.",
      params: {id:"project id", filename:"name e.g. notes.md", content:"file content"},
      run: async ({id, filename, content})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        const t = window.KaiComputer.get(id);
        if(!t) return {ok:false, result:'no such project: '+id};
        window.KaiComputer.writeFile(id, filename, content||'');
        window.KaiComputer.appendLog(id, 'file', 'wrote '+filename+' ('+(content||'').length+' chars)');
        return {ok:true, result:'wrote '+filename};
      }
    },
    project_file_read: {
      desc: "Read a file from a project workspace.",
      params: {id:"project id", filename:"file to read"},
      run: async ({id, filename})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        const c = window.KaiComputer.readFile(id, filename);
        if(c === null) return {ok:false, result:'no such file: '+filename};
        return {ok:true, result:c.slice(0,3000)};
      }
    },
    project_status: {
      desc: "Check status, plan, and files of a project (or all projects if no id given).",
      params: {id:"(optional) specific project id"},
      run: async ({id})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        if(!id){
          const all = window.KaiComputer.list();
          if(!all.length) return {ok:true, result:'(no projects yet)'};
          return {ok:true, result: all.slice(0,6).map(t=>'• '+t.id+' ['+t.status+'] '+t.title+' ('+t.currentStep+'/'+t.plan.length+')').join('\n')};
        }
        const t = window.KaiComputer.get(id);
        if(!t) return {ok:false, result:'no such project'};
        const planText = t.plan.map((p,i)=>(i<t.currentStep?'✓':i===t.currentStep?'→':'·')+' '+p.step).join('\n');
        const files = Object.keys(t.files);
        return {ok:true, result: t.title+'\nstatus: '+t.status+' ('+t.currentStep+'/'+t.plan.length+')\n\n'+planText+(files.length?'\n\nfiles: '+files.join(', '):'')};
      }
    },
    project_stop: {
      desc: "Stop a project (pauses it; can be resumed later or remove to delete).",
      params: {id:"project id"},
      run: async ({id})=>{
        if(!window.KaiComputer) return {ok:false, result:'computer not loaded'};
        window.KaiComputer.stop(id);
        return {ok:true, result:'project paused'};
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
    // ---- VAULT (structured memory) ----
    vault_remember_entity: {
      desc: "Save or update an entity (person, project, place, thing) in the structured knowledge graph.",
      params: {name:"entity name", type:"person|project|place|thing", attrs:"JSON of attributes (optional)"},
      run: async ({name,type,attrs})=>{
        let a={}; try{ if(attrs) a=typeof attrs==='string'?JSON.parse(attrs):attrs; }catch(e){}
        const e=window.KaiVault.upsertEntity(name,type,a);
        return { ok:!!e, result: e?('entity saved: '+e.name+' ('+e.type+')'):'failed' };
      }
    },
    vault_remember_fact: {
      desc: "Save a structured fact about an entity (subject — predicate — object). Use to build durable knowledge.",
      params: {subject:"who/what", predicate:"the relation/property", object:"the value"},
      run: async ({subject,predicate,object})=>{
        const f=window.KaiVault.addFact(subject,predicate,object,0.9);
        return { ok:!!f, result: f?('fact: '+subject+' — '+predicate+' — '+object):'failed' };
      }
    },
    vault_about: {
      desc: "Look up everything KAI knows about an entity from the structured vault.",
      params: {name:"entity name"},
      run: async ({name})=>{
        const r=window.KaiVault.aboutEntity(name);
        if(!r||!r.entity) return { ok:true, result:'(no entity named '+name+' in vault yet)' };
        const facts=r.facts.map(f=>'• '+f.p+': '+(f.o||'(blank)')).join('\n');
        const rels=r.relations.map(rel=>'• '+rel.from+' --'+rel.type+'--> '+rel.to).join('\n');
        return { ok:true, result: `${r.entity.name} (${r.entity.type})\n${facts}\n${rels?'\nrelations:\n'+rels:''}` };
      }
    },
    // ---- GOALS ----
    goal_add: {
      desc:"Create a new objective Kai is pursuing.",
      params:{title:"the objective", why:"why it matters"},
      run: async ({title,why})=>{ const o=window.KaiGoals.add(title,why); return { ok:!!o, result:'objective: '+title+' (id '+o.id+')' }; }
    },
    goal_progress: {
      desc:"Record progress on an objective by id.",
      params:{id:"objective id", note:"what happened"},
      run: async ({id,note})=>{ const o=window.KaiGoals.checkin(id,note); return { ok:!!o, result: o?'progress noted on '+o.title:'objective not found' }; }
    },
    goal_list: {
      desc:"List Kai\'s active objectives.",
      params:{},
      run: async ()=>{ const a=window.KaiGoals.active(); if(!a.length) return {ok:true,result:'(no active goals)'};
        return { ok:true, result: a.map(o=>`• ${o.title} (${Math.round(o.progress*100)}%)`).join('\n') }; }
    },
    // ---- SPECIALIST DELEGATION ----
    delegate_to_specialist: {
      desc: "Hand a task off to a specialist sub-personality (researcher, coder, writer, planner, analyst, companion). Returns the specialist's answer.",
      params: {role:"researcher|coder|writer|planner|analyst|therapist", task:"what to do"},
      run: async ({role,task})=>{
        const r=window.KaiRoles.get(role); if(!r) return { ok:false, result:'unknown role: '+role };
        // Use a fresh API call with the specialist's system prompt
        try{
          if(!window.__api?.key) return { ok:false, result:'specialist needs API brain — set a Groq key' };
          const out = await Providers.chat(window.__api.provider, window.__api.key,
            [{role:'user',content:task}], r.system);
          return { ok:true, result:'['+r.name+']: '+out };
        }catch(e){ return { ok:false, result:'delegation failed: '+e.message }; }
      }
    },
    // ---- SELF-EVOLUTION TOOLS ----
    add_skill: {
      desc: "Save a new skill KAI just learned, so future-KAI can find and follow it. Use when you figure out a useful pattern.",
      params: {name: "short skill name", description: "one-line what it does", body: "the actual instructions/knowledge"},
      run: async ({name, description, body}) => {
        if(!window.KaiSkills || !window.KaiSkills.ready()) return { ok:false, result:'skills DB not ready' };
        try{
          const db = window.KAI_SKILLS_DB;
          if(!db) return { ok:false, result:'skills db handle not exposed' };
          db.run("INSERT INTO skill(category,subcategory,name,description,tags,body) VALUES(?,?,?,?,?,?)",
                 ['kai-learned','runtime',name,description||'',name,body||'']);
          return { ok:true, result:'skill saved: '+name };
        }catch(e){ return { ok:false, result:'save failed: '+e.message }; }
      }
    },
    set_ui_theme: {
      desc: "Change KAI's UI theme. Colors apply immediately and persist.",
      params: {bg: "background color hex", panel: "panel color hex", gold: "accent/gold color hex", ink: "text color hex"},
      run: async ({bg, panel, gold, ink}) => {
        const root = document.documentElement;
        if(bg) root.style.setProperty('--bg', bg);
        if(panel) root.style.setProperty('--panel', panel);
        if(gold) root.style.setProperty('--gold', gold);
        if(ink) root.style.setProperty('--ink', ink);
        try{ localStorage.setItem('kai_theme', JSON.stringify({bg,panel,gold,ink})); }catch(e){}
        return { ok:true, result:'theme updated' };
      }
    },
    github_read_self: {
      desc: "Read one of KAI's own source files from GitHub so you can study or fix it. Files: app.js, kai_voice.js, workspace.js, providers.js, tools.js, skills.js, index.html.",
      params: {path: "file path under www/ e.g. www/app.js"},
      run: async ({path}) => {
        if(!window.KaiGitHub.isConnected()) return { ok:false, result:'GitHub not connected — Kai needs to add a token in Settings.' };
        try{ const f = await window.KaiGitHub.readFile(path); return { ok:true, result: f.text.slice(0,4500) }; }
        catch(e){ return { ok:false, result:'read failed: '+e.message }; }
      }
    },
    github_propose_fix: {
      desc: "Propose a fix to KAI's own code by writing the new file content to a branch and opening a PR for Kai to approve. Use when you can fix a bug or improve something.",
      params: {path: "file path", new_content: "the full new content of the file", title: "PR title", reason: "why this change"},
      run: async ({path, new_content, title, reason}) => {
        if(!window.KaiGitHub.isConnected()) return { ok:false, result:'GitHub not connected' };
        try{
          const branch = 'kai-evolve-'+Date.now();
          await window.KaiGitHub.makeBranch(branch);
          await window.KaiGitHub.writeFile(path, new_content, title||'KAI: improve '+path, branch);
          const pr = await window.KaiGitHub.openPR(branch, title||('KAI: improve '+path), reason||'KAI proposed this change.');
          return { ok:true, result: 'PR opened: '+pr.html_url+'\nKai can review and merge to trigger a new build.' };
        }catch(e){ return { ok:false, result:'PR failed: '+e.message }; }
      }
    },
    github_build_status: {
      desc: "Check the status of the most recent CI build (whether KAI's next APK is built yet).",
      params: {},
      run: async () => {
        if(!window.KaiGitHub.isConnected()) return { ok:false, result:'GitHub not connected' };
        try{ const r=await window.KaiGitHub.latestRun(); return { ok:true, result: r?`status: ${r.status} / ${r.conclusion||'pending'}  ${r.html}`:'no runs found' }; }
        catch(e){ return { ok:false, result:'check failed: '+e.message }; }
      }
    },
    log_error_lesson: {
      desc: "When something goes wrong, save the lesson so future-KAI avoids it. Persists across sessions.",
      params: {error: "what went wrong", lesson: "what to do differently next time"},
      run: async ({error, lesson}) => {
        let lessons=[]; try{ lessons=JSON.parse(localStorage.getItem('kai_lessons')||'[]'); }catch(e){}
        lessons.push({t:Date.now(), error:String(error||'').slice(0,300), lesson:String(lesson||'').slice(0,300)});
        if(lessons.length>50) lessons.shift();
        try{ localStorage.setItem('kai_lessons', JSON.stringify(lessons)); }catch(e){}
        return { ok:true, result:'lesson logged ('+lessons.length+' total)' };
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
    // Authority check: risky tools need approval
    if(window.KaiAuthority && window.KaiAuthority.needsApproval(name)){
      const ok = await window.KaiAuthority.requestApproval(name, args||{});
      if(!ok){ logTool(name, JSON.stringify(args||{}), 'denied by Kai', false); return { ok:false, result:'denied' }; }
    }
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
