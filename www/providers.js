// Provider auto-detection + unified chat call.
// Paste a key -> detect which provider -> route correctly. Local stays default.
window.Providers = (function(){
  const DEFS = {
    anthropic: {
      test: k => /^sk-ant-/.test(k),
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-3-5-haiku-20241022",
      build: (k,msgs,sys) => ({
        headers:{"Content-Type":"application/json","x-api-key":k,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body: JSON.stringify({model:"claude-3-5-haiku-20241022",max_tokens:512,system:sys,messages:msgs})
      }),
      parse: d => d.content?.map(b=>b.text||"").join("") || ""
    },
    groq: {
      test: k => /^gsk_/.test(k),
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      build: (k,msgs,sys) => ({
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+k},
        body: JSON.stringify({model:"llama-3.3-70b-versatile",max_tokens:512,messages:[{role:"system",content:sys},...msgs]})
      }),
      parse: d => d.choices?.[0]?.message?.content || ""
    },
    mistral: {
      test: k => /^[A-Za-z0-9]{32}$/.test(k),  // mistral keys are 32-char alnum
      url: "https://api.mistral.ai/v1/chat/completions",
      model: "mistral-small-latest",
      build: (k,msgs,sys) => ({
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+k},
        body: JSON.stringify({model:"mistral-small-latest",max_tokens:512,messages:[{role:"system",content:sys},...msgs]})
      }),
      parse: d => d.choices?.[0]?.message?.content || ""
    },
    openai: {
      test: k => /^sk-(proj-)?/.test(k),  // catch-all sk- (checked last)
      url: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      build: (k,msgs,sys) => ({
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+k},
        body: JSON.stringify({model:"gpt-4o-mini",max_tokens:512,messages:[{role:"system",content:sys},...msgs]})
      }),
      parse: d => d.choices?.[0]?.message?.content || ""
    },
  };
  // order matters: specific prefixes before the sk- catch-all
  const ORDER = ["anthropic","groq","mistral","openai"];

  function detect(key){
    key=(key||"").trim();
    for(const name of ORDER){ if(DEFS[name].test(key)) return name; }
    return null;
  }

  // verify the key actually works (also disambiguates sk- overlaps)
  async function verify(name,key){
    const d=DEFS[name]; if(!d) return false;
    try{
      const {headers,body}=d.build(key,[{role:"user",content:"hi"}],"Reply with: ok");
      const r=await fetch(d.url,{method:"POST",headers,body});
      return r.ok;
    }catch(e){ return false; }
  }

  async function chat(name,key,msgs,sys){
    const d=DEFS[name]; if(!d) throw new Error("unknown provider");
    const {headers,body}=d.build(key,msgs,sys);
    const r=await fetch(d.url,{method:"POST",headers,body});
    if(!r.ok){ const t=await r.text(); throw new Error("API "+r.status+": "+t.slice(0,120)); }
    const data=await r.json();
    return d.parse(data);
  }

  return { detect, verify, chat, names:ORDER, model:(n)=>DEFS[n]?.model };
})();
