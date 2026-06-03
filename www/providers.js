// Provider auto-detection + unified chat call.
// Paste a key -> detect which provider -> route correctly. Local stays default.
window.Providers = (function(){
  const DEFS = {
    anthropic: {
      test: k => /^sk-ant-/.test(k),
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-haiku-4-5",
      build: (k,msgs,sys) => ({
        headers:{"Content-Type":"application/json","x-api-key":k,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body: JSON.stringify({model:"claude-haiku-4-5",max_tokens:512,system:sys,messages:msgs})
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
    const d=DEFS[name]; if(!d) return {ok:false,reason:'unknown provider'};
    try{
      const {headers,body}=d.build(key,[{role:'user',content:'hi'}],'Reply with ok');
      const r=await fetch(d.url,{method:'POST',headers,body});
      if(r.ok) return {ok:true};
      if(r.status===401||r.status===403){
        return {ok:false,reason:'key rejected ('+r.status+')'};
      }
      // 400/429/5xx etc -> key is likely fine, just this probe failed
      return {ok:true,soft:true,reason:'accepted (provider returned '+r.status+' on probe)'};
    }catch(e){
      // network / CORS failure in WebView — cannot confirm, but format was valid.
      return {ok:true,soft:true,reason:'format valid; connection will be confirmed on first message'};
    }
  }

  async function chat(name,key,msgs,sys){
    const d=DEFS[name]; if(!d) throw new Error("unknown provider");
    const {headers,body}=d.build(key,msgs,sys);
    const r=await fetch(d.url,{method:"POST",headers,body});
    if(!r.ok){ const t=await r.text(); throw new Error("API "+r.status+": "+t.slice(0,120)); }
    const data=await r.json();
    return d.parse(data);
  }



  // ---- TOOL CALLING ----
  // Models that support OpenAI-style tools (groq, openai, mistral)
  function _openaiTools(toolspec){
    return Object.entries(toolspec).map(([name,t])=>({
      type:"function",
      function:{
        name, description: t.desc,
        parameters:{ type:"object", properties: Object.fromEntries(
          Object.entries(t.params).map(([k,v])=>[k,{type:"string",description:v}])
        ), required: [] }
      }
    }));
  }

  async function agenticChat(name, key, msgs, sys, toolspec, runTool){
    const d = DEFS[name]; if(!d) throw new Error("unknown provider");
    const supportsTools = (name==="groq"||name==="openai"||name==="mistral");
    let history = [{role:"system", content: sys}, ...msgs];
    if(!supportsTools){
      // Anthropic: ask for JSON-shaped tool intent in the reply; we parse it
      const ask = sys + "\n\nYou have these tools available:\n" + Object.entries(toolspec).map(([n,t])=>`- ${n}(${Object.keys(t.params).join(",")}): ${t.desc}`).join("\n") +
        "\n\nIf a tool would help, respond ONLY with a single JSON object: {\"tool\":\"<name>\",\"args\":{...}}. Otherwise respond normally to the user.";
      let reply = await chat(name, key, msgs, ask);
      const m = reply.match(/\{[\s\S]*?\"tool\"[\s\S]*?\}/);
      if(m){
        try{
          const call = JSON.parse(m[0]);
          const r = await runTool(call.tool, call.args||{});
          const ctx = `Tool ${call.tool} returned:\n${r.result}\n\nNow give the final answer to the user, in Kai's voice. Be brief.`;
          reply = await chat(name, key, [...msgs, {role:"assistant",content:"(used "+call.tool+")"}, {role:"user",content:ctx}], sys);
          return { text: reply, used: [call.tool], extra: r.html?{html:r.html}:null };
        }catch(e){}
      }
      return { text: reply, used: [], extra: null };
    }
    // OpenAI-compatible loop
    const tools = _openaiTools(toolspec);
    const used = []; let extraHtml = null;
    for(let step=0; step<3; step++){
      const url = DEFS[name].url;
      const body = {
        model: DEFS[name].model, max_tokens: 700,
        messages: history, tools, tool_choice: "auto"
      };
      const r = await fetch(url,{method:"POST", headers: DEFS[name].build(key,[],"").headers, body: JSON.stringify(body)});
      if(!r.ok){ const t=await r.text(); throw new Error("API "+r.status+": "+t.slice(0,160)); }
      const data = await r.json();
      const m = data.choices?.[0]?.message;
      if(!m) return { text: "", used, extra: extraHtml };
      // tool call?
      const calls = m.tool_calls || [];
      if(!calls.length){
        return { text: m.content||"", used, extra: extraHtml };
      }
      history.push(m);
      for(const c of calls){
        let args = {};
        try{ args = JSON.parse(c.function.arguments||"{}"); }catch(e){}
        const res = await runTool(c.function.name, args);
        used.push(c.function.name);
        if(res.html) extraHtml = res.html;
        history.push({role:"tool", tool_call_id: c.id, name: c.function.name, content: String(res.result||"").slice(0,2000)});
      }
    }
    return { text: "(stopped after a few tool steps)", used, extra: extraHtml };
  }


  return { detect, verify, chat, agenticChat, names:ORDER, model:(n)=>DEFS[n]?.model };
})();
