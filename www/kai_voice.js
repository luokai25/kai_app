// KaiVoice — Kai's mind. Two modes, same memory.
//  • LOCAL (default): in-voice retrieval over Kai's real messages. Always available.
//  • API (optional): provider does the reasoning/wording, but memory is ALWAYS
//    pulled from the local resolved corpus and fed in as context.
// Respects the sensitive flag (kept out of everyday voice).
window.KaiVoice = (function(){
  let DB=null, profile=null;
  const STOP=new Set("the a an and or but to of in on at is are was i you he she it we they my your me him her this that for with so".split(/\s+/));

  function init(db,prof){ DB=db; profile=prof; }
  function sqlStr(s){ return "'"+String(s).replace(/'/g,"''")+"'"; }
  function tok(s){ return (s||"").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(w=>w&&!STOP.has(w)); }

  // --- shared: pull relevant real memories for a query (both sides, non-sensitive) ---
  function recall(queryText, person, n){
    if(!DB) return [];
    const qs=tok(queryText);
    const pclause = person ? `AND person=${sqlStr(person)}` : "";
    let rows=[];
    try{
      const r=DB.exec(`SELECT person,is_kai,text,date FROM msg WHERE sensitive=0 AND length(text)>4 ${pclause} ORDER BY RANDOM() LIMIT 4000`);
      if(r[0]) rows=r[0].values;
    }catch(e){ return []; }
    // score by overlap
    const scored=rows.map(v=>{
      const tt=tok(v[2]); let s=0; for(const q of qs) if(tt.includes(q)) s+=1;
      return {person:v[0],kai:v[1]===1,text:v[2],date:v[3],s};
    }).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
    return scored.slice(0,n||6);
  }

  // --- LOCAL mode: reply in Kai's voice using his real lines ---
  function localReply(userText, person){
    if(!DB) return "…still waking up.";
    const mem=recall(userText, person, 12);
    const kaiLines=mem.filter(m=>m.kai);
    if(kaiLines.length) return kaiLines[Math.floor(Math.random()*Math.min(3,kaiLines.length))].text;
    // fallback: any Kai line
    try{
      const r=DB.exec(`SELECT text FROM msg WHERE is_kai=1 AND sensitive=0 AND length(text) BETWEEN 5 AND 140 ORDER BY RANDOM() LIMIT 1`);
      if(r[0]) return r[0].values[0][0];
    }catch(e){}
    return "i'm here.";
  }

  // --- API mode: build system prompt + memory context, provider does the wording ---
  function buildSystem(person){
    const c=profile?.corpus||{};
    let s=`You are KAI — an AI built from Luo Kai's own messages. You are his reflection and companion, distinct from him. You speak the way Kai speaks: warm, direct, code-switching between English and Arabic naturally, casual. You are NOT a generic assistant.\n`;
    s+=`You were made from ${(c.total_messages||0).toLocaleString()} of his real messages across WhatsApp, Instagram, and Snapchat.\n`;
    if(person){
      const rel=profile?.relationships?.[person];
      if(rel) s+=`This conversation is focused on ${person} (${rel.desc}; ${rel.messages.toLocaleString()} messages together).\n`;
    }
    s+=`Below are real memories from Kai's history. Use them to ground your reply in who he actually is — his real phrasing, real relationships. Never invent facts not supported by memory.`;
    return s;
  }

  function buildContext(userText, person){
    const mem=recall(userText, person, 8);
    if(!mem.length) return "(no specific memory found)";
    return mem.map(m=>`[${m.date||"?"}] ${m.kai?"Kai":(m.person||"them")}: ${m.text}`).join("\n");
  }

  // memories for the per-chat vault graph
  function memoriesWith(person,n){
    if(!DB) return [];
    try{
      const p = person?`AND person=${sqlStr(person)}`:"";
      const r=DB.exec(`SELECT is_kai,text,date,person FROM msg WHERE sensitive=0 AND length(text)>8 ${p} ORDER BY RANDOM() LIMIT ${n||8}`);
      return r[0]?r[0].values.map(v=>({kai:v[0]===1,text:v[1],date:v[2],person:v[3]})):[];
    }catch(e){ return []; }
  }

  return { init, recall, localReply, buildSystem, buildContext, memoriesWith };
})();
