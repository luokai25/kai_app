// KAI Providers — robust multi-provider API layer.
// Supports: Anthropic, Groq, Mistral, OpenAI, Together AI, DeepSeek, Cerebras, OpenRouter, Fireworks, xAI Grok, Cohere.
// Paste any key → auto-detect → verify with retry → use. Falls back gracefully on transient errors.
window.Providers = (function(){

  // Provider definitions. Each provider has:
  //   test(key): regex check on key format
  //   url, model
  //   chatBody(msgs, sys): JSON body shape for non-streaming chat
  //   headers(key): auth headers
  //   parse(data): extract reply text
  //   supportsTools: whether OpenAI-style tools/function-calling works
  const DEFS = {
    // ---- ANTHROPIC ----
    anthropic: {
      test: k => /^sk-ant-/.test(k),
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-haiku-4-5",
      headers: k => ({"Content-Type":"application/json","x-api-key":k,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"claude-haiku-4-5", max_tokens: maxTok||2000, system: sys||undefined, messages: msgs}),
      parse: d => Array.isArray(d.content) ? d.content.map(b=>b.text||"").join("") : (d.content?.[0]?.text || ""),
      supportsTools: false  // uses Anthropic's own tool format, we use JSON-fallback in agentic loop
    },
    // ---- GROQ (OpenAI-compatible, fastest) ----
    groq: {
      test: k => /^gsk_/.test(k),
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"llama-3.3-70b-versatile", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- OPENAI ----
    openai: {
      test: k => /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/.test(k),
      url: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"gpt-4o-mini", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- MISTRAL ----
    mistral: {
      test: k => /^[A-Za-z0-9]{32}$/.test(k),
      url: "https://api.mistral.ai/v1/chat/completions",
      model: "mistral-small-latest",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"mistral-small-latest", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- DEEPSEEK (OpenAI-compatible, cheap, strong on code/math) ----
    deepseek: {
      test: k => /^sk-[A-Za-z0-9]{32,}/.test(k) && k.length < 80,
      url: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"deepseek-chat", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- TOGETHER AI ----
    together: {
      test: k => /^[a-f0-9]{64}$/.test(k),
      url: "https://api.together.xyz/v1/chat/completions",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"meta-llama/Llama-3.3-70B-Instruct-Turbo", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- CEREBRAS (very fast inference) ----
    cerebras: {
      test: k => /^csk-/.test(k),
      url: "https://api.cerebras.ai/v1/chat/completions",
      model: "llama-3.3-70b",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"llama-3.3-70b", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- OPENROUTER (gateway to 100+ models) ----
    openrouter: {
      test: k => /^sk-or-/.test(k),
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "anthropic/claude-3.5-haiku",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k,"HTTP-Referer":"https://kai.local","X-Title":"KAI"}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"anthropic/claude-3.5-haiku", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- xAI GROK ----
    xai: {
      test: k => /^xai-/.test(k),
      url: "https://api.x.ai/v1/chat/completions",
      model: "grok-2-latest",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"grok-2-latest", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
    // ---- FIREWORKS ----
    fireworks: {
      test: k => /^fw_/.test(k),
      url: "https://api.fireworks.ai/inference/v1/chat/completions",
      model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
      headers: k => ({"Content-Type":"application/json","Authorization":"Bearer "+k}),
      chatBody: (msgs, sys, model, maxTok) => JSON.stringify({model: model||"accounts/fireworks/models/llama-v3p3-70b-instruct", max_tokens: maxTok||2000, messages: sys?[{role:"system",content:sys},...msgs]:msgs}),
      parse: d => d.choices?.[0]?.message?.content || "",
      supportsTools: true
    },
  };

  // Detection order — most specific prefixes first; sk- catch-all (openai/deepseek) is ambiguous
  // so we detect openai/deepseek/anthropic together and disambiguate via verify when needed.
  const ORDER = ["anthropic","groq","cerebras","openrouter","xai","fireworks","together","mistral","deepseek","openai"];

  function detect(key){
    key = (key||"").trim();
    for(const name of ORDER){ if(DEFS[name].test(key)) return name; }
    return null;
  }

  function listProviders(){ return Object.keys(DEFS).map(n=>({name:n, model:DEFS[n].model})); }

  // Robust fetch with timeout + retry on 5xx/network
  async function _fetch(url, opts, timeoutMs){
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeoutMs||30000);
    let lastErr;
    for(let attempt=0; attempt<2; attempt++){
      try{
        const r = await fetch(url, {...opts, signal: ac.signal});
        clearTimeout(t);
        if(r.status >= 500 && attempt < 1){ lastErr = new Error("server "+r.status); continue; }
        return r;
      }catch(e){
        lastErr = e;
        if(attempt < 1 && !ac.signal.aborted) continue;
        clearTimeout(t); throw e;
      }
    }
    clearTimeout(t);
    throw lastErr || new Error("fetch failed");
  }

  // Verify a key. Returns {ok, soft?, reason?}.
  async function verify(name, key){
    // Soft-by-default: only refuse on explicit auth rejection (401/403).
    // CORS, network blips, rate limits, transient server errors -> soft-accept.
    // The real test is the first message; this just sanity-checks the format.
    const d = DEFS[name]; if(!d) return {ok:false, reason:"unknown provider"};
    if(!d.test(key)) return {ok:false, reason:"key format doesn't match "+name};
    try{
      const body = d.chatBody([{role:"user",content:"hi"}], "Reply: ok");
      const r = await _fetch(d.url, {method:"POST", headers: d.headers(key), body}, 12000);
      if(r.ok) return {ok:true};
      if(r.status === 401 || r.status === 403){
        const t = await r.text();
        return {ok:false, reason:`key rejected (${r.status}): ${t.slice(0,140)}`};
      }
      // any other status — soft accept
      return {ok:true, soft:true, reason:`format valid (probe ${r.status} — will use)`};
    }catch(e){
      // network/CORS error — soft accept, format already validated
      return {ok:true, soft:true, reason:"format valid (network blocked probe — will use)"};
    }
  }

  // Plain chat — no tool calling. (name, key, msgs, sys, opts?)
  async function chat(name, key, msgs, sys, opts){
    const d = DEFS[name]; if(!d) throw new Error("unknown provider: "+name);
    const model = opts?.model;
    const maxTok = opts?.max_tokens;
    const body = d.chatBody(msgs, sys, model, maxTok);
    const r = await _fetch(d.url, {method:"POST", headers: d.headers(key), body}, opts?.timeoutMs||45000);
    if(!r.ok){
      const txt = await r.text();
      throw new Error(`API ${r.status}: ${txt.slice(0,200)}`);
    }
    const data = await r.json();
    return d.parse(data);
  }

  // OpenAI-style tools array from KaiWorkspace toolspec
  function _toolsSchema(toolspec){
    return Object.entries(toolspec).map(([name,t])=>({
      type:"function",
      function:{
        name, description: t.desc,
        parameters:{
          type:"object",
          properties: Object.fromEntries(
            Object.entries(t.params||{}).map(([k,v])=>[k,{type:"string", description:v}])
          ),
          required: []
        }
      }
    }));
  }

  // Agentic loop with tool calling.
  async function agenticChat(name, key, msgs, sys, toolspec, runTool, opts){
    const d = DEFS[name]; if(!d) throw new Error("unknown provider: "+name);
    if(!d.supportsTools){
      // Fallback: ask for JSON tool intent
      const tdesc = Object.entries(toolspec).map(([n,t])=>`- ${n}(${Object.keys(t.params||{}).join(",")}): ${t.desc}`).join("\n");
      const augSys = (sys||"") + `\n\nYou have these tools available:\n${tdesc}\n\nIf a tool would help, respond ONLY with a single JSON object: {"tool":"<name>","args":{...}}. Otherwise respond normally.`;
      let reply = await chat(name, key, msgs, augSys, opts);
      const m = reply.match(/\{[\s\S]*?"tool"[\s\S]*?\}/);
      if(m){
        try{
          const call = JSON.parse(m[0]);
          const res = await runTool(call.tool, call.args||{});
          const followUp = await chat(name, key,
            [...msgs, {role:"assistant", content:`(used ${call.tool})`}, {role:"user", content:`Tool returned:\n${res.result}\n\nNow answer the user briefly, in Kai's voice.`}],
            sys, opts);
          return { text: followUp, used: [call.tool], extra: res.html?{html:res.html}:null };
        }catch(e){ /* fall through */ }
      }
      return { text: reply, used: [], extra: null };
    }
    // OpenAI-compatible ADAPTIVE tool loop. Knows when to stop, when to push, when to bail.
    const tools = _toolsSchema(toolspec);
    const history = [{role:"system", content: sys||""}, ...msgs];
    const used = []; let extraHtml = null;
    const MAX_STEPS = opts?.maxSteps || 666;
    const MAX_TOK = opts?.max_tokens || 2000;
    let consecutiveErrors = 0;
    let lastCallFingerprint = null;
    let repeatedCallCount = 0;
    let lastTextOnlyCheckpoint = "";

    for(let step=0; step<MAX_STEPS; step++){
      // Adaptive budget warning: when 90% used, tell the model to wrap up
      if(step === Math.floor(MAX_STEPS * 0.9)){
        history.push({role:"system", content:"You're approaching the step budget ("+step+"/"+MAX_STEPS+"). Wrap up — finish the most important pieces and return a summary."});
      }
      const body = JSON.stringify({
        model: opts?.model || d.model,
        max_tokens: MAX_TOK,
        messages: history,
        tools, tool_choice: "auto"
      });
      let r;
      try{
        r = await _fetch(d.url, {method:"POST", headers: d.headers(key), body}, opts?.timeoutMs||60000);
      }catch(netErr){
        consecutiveErrors++;
        if(consecutiveErrors >= 3) throw netErr;
        // brief backoff and retry
        await new Promise(res=>setTimeout(res, 1500*consecutiveErrors));
        continue;
      }
      if(!r.ok){
        consecutiveErrors++;
        if(consecutiveErrors >= 3){
          const t = await r.text();
          throw new Error(`API ${r.status}: ${t.slice(0,200)}`);
        }
        await new Promise(res=>setTimeout(res, 1500*consecutiveErrors));
        continue;
      }
      consecutiveErrors = 0;
      const data = await r.json();
      const m = data.choices?.[0]?.message;
      if(!m) return { text: lastTextOnlyCheckpoint, used, extra: extraHtml };
      const calls = m.tool_calls || [];

      // ADAPTIVE STOP: no tool calls + text means we're done
      if(!calls.length){
        return { text: m.content||lastTextOnlyCheckpoint, used, extra: extraHtml };
      }

      // Save any partial text the model produced alongside tool calls (some models do this)
      if(m.content) lastTextOnlyCheckpoint = m.content;

      // STUCK DETECTION: same tool + same args twice in a row → hint and gentle nudge
      const fingerprint = JSON.stringify(calls.map(c=>({n:c.function?.name, a:c.function?.arguments})));
      if(fingerprint === lastCallFingerprint){
        repeatedCallCount++;
        if(repeatedCallCount === 1){
          history.push({role:"system", content:"You just repeated the same tool call. The same call won't give different results. Try a different approach: different tool, different args, or finalize your answer."});
        } else if(repeatedCallCount >= 3){
          // Genuinely stuck — bail with what we have
          return { text: (lastTextOnlyCheckpoint || "(loop detected — stopping)"), used, extra: extraHtml };
        }
      } else {
        repeatedCallCount = 0;
        lastCallFingerprint = fingerprint;
      }

      history.push(m);
      for(const c of calls){
        let args = {};
        try{ args = JSON.parse(c.function?.arguments || "{}"); }catch(e){
          history.push({role:"tool", tool_call_id: c.id, name: c.function.name, content: "Error parsing your tool arguments as JSON: "+e.message+". Please retry with valid JSON arguments."});
          continue;
        }
        let res;
        try{
          res = await runTool(c.function.name, args);
        }catch(e){
          // Don't crash the loop — feed the error back to the model so it can self-correct
          res = { ok:false, result: "Tool threw an error: "+e.message+". You can retry or try a different approach." };
        }
        used.push(c.function.name);
        if(res.html) extraHtml = res.html;
        history.push({role:"tool", tool_call_id: c.id, name: c.function.name, content: String(res.result||"").slice(0,3000)});
      }
    }
    return { text: "(stopped after max steps)", used, extra: extraHtml };
  }

  return { detect, verify, chat, agenticChat, listProviders, names:ORDER, model:(n)=>DEFS[n]?.model };
})();
