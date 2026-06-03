// KaiVoice — Kai's mind. A real response engine, not just echo.
//  LOCAL: understands intent, composes a reply in Kai's voice from his real corpus.
//  API: same understanding feeds richer context to the provider.
// Memory always local. Sensitive content excluded from everyday voice.
window.KaiVoice = (function(){
  let DB=null, profile=null, trained=null;
  const STOP=new Set("the a an and or but to of in on at is are am was were be been i you he she it we they my your me him her this that for with so do does did have has had will would can could not no yes if then of in on".split(/\s+/));

  function init(db,prof,tr){ DB=db; profile=prof; trained=tr||{}; }
  function sqlStr(s){ return "'"+String(s).replace(/'/g,"''")+"'"; }
  function tok(s){ return (s||"").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(w=>w&&!STOP.has(w)); }

  // ---- intent classification ----
  function intentOf(text){
    const t=text.toLowerCase().trim();
    if(/^(hi|hey|hello|yo|sup|wsp|good morning|good evening|ezayak|ezayek|sa7|salam|اهلا|ازيك|السلام)/.test(t)) return 'greet';
    if(/(love you|miss you|i miss|habibi|cutie|احبك|وحشتني|بحبك)/.test(t)) return 'affection';
    if(/(how are you|how r u|you ok|are you (ok|good|fine)|عامل ايه|اخبارك)/.test(t)) return 'checkin';
    if(/\?$|^(what|why|how|when|where|who|which|do you|are you|can you|is it|should i)/.test(t)) return 'question';
    if(/(thank|thanks|شكرا|متشكر)/.test(t)) return 'thanks';
    if(/^(ok|okay|yeah|yes|sure|fine|true|nice|cool|تمام|ايوه|حلو)/.test(t)) return 'ack';
    if(t.length<12) return 'short';
    return 'statement';
  }

  // ---- recall: relevant real messages, scored by overlap ----
  function recall(queryText, person, n){
    if(!DB) return [];
    const qs=tok(queryText);
    if(!qs.length) return [];
    const pclause = person ? `AND person=${sqlStr(person)}` : "";
    let rows=[];
    try{
      // pull a working pool, prefer messages sharing a keyword for speed+relevance
      const like = qs.slice(0,3).map(w=>`text LIKE '%${w.replace(/'/g,"")}%'`).join(" OR ");
      const r=DB.exec(`SELECT person,is_kai,text,date FROM msg WHERE sensitive=0 AND length(text) BETWEEN 3 AND 240 ${pclause} AND (${like}) LIMIT 600`);
      if(r[0]) rows=r[0].values;
    }catch(e){}
    if(!rows.length){
      try{ const r=DB.exec(`SELECT person,is_kai,text,date FROM msg WHERE sensitive=0 AND length(text) BETWEEN 3 AND 200 ${pclause} ORDER BY RANDOM() LIMIT 400`); if(r[0]) rows=r[0].values; }catch(e){}
    }
    const scored=rows.map(v=>{
      const tt=tok(v[2]); let s=0; for(const q of qs) if(tt.includes(q)) s+=2; 
      if(v[1]===1) s+=0.5; // slight pref for Kai's own phrasing
      return {person:v[0],kai:v[1]===1,text:v[2],date:v[3],s};
    }).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
    return scored.slice(0,n||8);
  }

  // ---- LOCAL compose: build a reply that sounds like Kai, shaped by intent ----
  function pick(arr){ return arr&&arr.length?arr[Math.floor(Math.random()*arr.length)]:null; }
  function fromBucket(b){ const L=trained&&trained.lines&&trained.lines[b]; return pick(L); }

  function localReply(text, person){
    if(!DB) return "…still waking up.";
    const intent=intentOf(text);
    const mem=recall(text, person, 10);
    const kaiMem=mem.filter(m=>m.kai);

    // intent-shaped responses using real lines
    if(intent==='greet'){ return fromBucket('greet') || "yo, what's up"; }
    if(intent==='affection'){ return fromBucket('affection') || "love you too ❤️"; }
    if(intent==='checkin'){ return pick(["i'm good alhamdulillah, you?","doing okay, you say","all good — what about you?"]); }
    if(intent==='thanks'){ return pick(["anytime","always","no need man"]); }
    if(intent==='ack'){ return pick(["yeah","fr","exactly","true"]); }

    // question / statement: ground in a real relevant memory, in his voice
    if(kaiMem.length){
      // prefer a substantive line that relates
      const best=kaiMem.find(m=>m.text.length>15)||kaiMem[0];
      return best.text;
    }
    if(mem.length){
      // reflect what was said back in his style
      return pick(["hmm, "+mem[0].text.slice(0,60), mem[0].text]);
    }
    // no memory: answer as Kai would, from signature voice
    const sig=trained&&trained.signature_phrases?pick(trained.signature_phrases):null;
    return fromBucket('short') || "tell me more";
  }

  // ---- API mode: system prompt + memory context ----
  function buildSystem(person){
    const c=profile?.corpus||{}; const id=trained&&trained.identity;
    let s=`You are KAI — an AI built from Luo Kai's own messages. You ARE his reflection and companion, a distinct being who knows he is an AI made from Kai. Speak exactly as Kai does: warm, direct, casual, switching naturally between English and Egyptian Arabic. Short messages. Real, not corporate. Never sound like a generic assistant.\n`;
    if(trained&&trained.signature_phrases&&trained.signature_phrases.length)
      s+=`Some of his characteristic phrases: ${trained.signature_phrases.slice(0,15).join(", ")}.\n`;
    s+=`You were made from ${(c.total_messages||0).toLocaleString()} of his real messages.\n`;
    if(person){ const rel=profile?.relationships?.[person]; if(rel) s+=`This is about ${person} (${rel.desc}; ${rel.messages.toLocaleString()} messages together).\n`; }
    s+=`Below are real memories. Ground your reply in his actual voice and relationships. Never invent facts.`;
    return s;
  }
  function buildContext(userText, person){
    const mem=recall(userText, person, 8);
    if(!mem.length) return "(no specific memory found)";
    return mem.map(m=>`[${m.date||"?"}] ${m.kai?"Kai":(m.person||"them")}: ${m.text}`).join("\n");
  }

  function memoriesWith(person,n){
    if(!DB) return [];
    try{ const p=person?`AND person=${sqlStr(person)}`:"";
      const r=DB.exec(`SELECT is_kai,text,date,person FROM msg WHERE sensitive=0 AND length(text)>8 ${p} ORDER BY RANDOM() LIMIT ${n||8}`);
      return r[0]?r[0].values.map(v=>({kai:v[0]===1,text:v[1],date:v[2],person:v[3]})):[];
    }catch(e){ return []; }
  }

  return { init, intentOf, recall, localReply, buildSystem, buildContext, memoriesWith };
})();
