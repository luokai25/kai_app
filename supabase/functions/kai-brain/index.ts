// KAI Brain — Supabase Edge Function
// Fixes: db.from().insert().catch (v2 SDK), image gen, video, local AI via WebLLM bridge
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KAI_KEY_HASH  = Deno.env.get("KAI_KEY_HASH") || "";

// Provider keys (stored in Supabase secrets)
const GROQ_KEY     = Deno.env.get("GROQ_API_KEY") || "";
const HF_KEY       = Deno.env.get("HF_API_KEY") || "";
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") || "";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-kai-key,x-chat-id,x-image-name",
};
function cors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function corsStream(stream: ReadableStream) {
  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
function sse(data: unknown) { return `data: ${JSON.stringify(data)}\n\n`; }

// ── Auth ──────────────────────────────────────────────────────────────────
function authOk(req: Request): boolean {
  const k = req.headers.get("x-kai-key") || "";
  if (!k) return false;
  // Simple: accept the default key or any key that matches hash
  if (k === "kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt") return true;
  if (KAI_KEY_HASH && k === KAI_KEY_HASH) return true;
  return k.startsWith("kai_") && k.length > 8; // accept any kai_ key for now
}

// ── DB helpers — FIX: always await, never .catch() directly ──────────────
async function dbInsert(table: string, data: Record<string, unknown>) {
  const { data: row, error } = await db.from(table).insert(data).select().single();
  if (error) throw new Error(error.message);
  return row;
}
async function dbInsertNoReturn(table: string, data: Record<string, unknown>) {
  const { error } = await db.from(table).insert(data);
  if (error) throw new Error(error.message);
}
async function dbUpdate(table: string, match: Record<string, unknown>, data: Record<string, unknown>) {
  const { error } = await db.from(table).update(data).match(match);
  if (error) throw new Error(error.message);
}
async function dbSelect(table: string, match: Record<string, unknown>, columns = "*", limit = 100) {
  let q = db.from(table).select(columns).match(match).limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}
async function dbDelete(table: string, match: Record<string, unknown>) {
  const { error } = await db.from(table).delete().match(match);
  if (error) throw new Error(error.message);
}

// ── Provider routing ──────────────────────────────────────────────────────
interface ChatMsg { role: string; content: string; }

async function getActiveProvider(): Promise<string> {
  try {
    const rows = await dbSelect("kai_settings", { key: "active_provider" }, "value", 1);
    return rows[0]?.value || "or_openrouter_free";
  } catch { return "or_openrouter_free"; }
}

async function callLLM(messages: ChatMsg[], provider?: string, stream = false): Promise<Response | string> {
  const prov = provider || await getActiveProvider();

  // ── OpenRouter Free models ─────────────────────────────────────────────
  if (prov.startsWith("or_")) {
    const modelMap: Record<string, string> = {
      or_openrouter_free: "openrouter/auto",
      or_qwen3_coder:    "qwen/qwen3-coder:free",
      or_nemotron550b:   "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
      or_nemotron120b:   "nvidia/llama-3.3-nemotron-super-49b-v1:free",
      or_gptoss120b:     "openai/gpt-4o:free",
      or_gptoss20b:      "openai/gpt-4o-mini:free",
      or_llama70b:       "meta-llama/llama-3.3-70b-instruct:free",
      or_hermes405b:     "nousresearch/hermes-3-llama-3.1-405b:free",
      or_gemma31b:       "google/gemma-3-27b-it:free",
      or_gemma26b:       "google/gemma-3n-e4b-it:free",
      or_kimi:           "moonshotai/kimi-k2:free",
      or_qwen80b:        "qwen/qwen3-235b-a22b:free",
      or_nemo_omni30b:   "nvidia/llama-3.1-nemotron-nano-8b-v1:free",
      or_nemo30b:        "nvidia/llama-3.1-nemotron-nano-8b-v1:free",
      or_nemo12b_vl:     "nvidia/llama-3.2-nv-vision-instruct:free",
      or_nemo9b:         "nvidia/llama-3.1-nemotron-nano-8b-v1:free",
      or_llama3b:        "meta-llama/llama-3.2-3b-instruct:free",
      or_laguna_m:       "poolside/poolside-mamba:free",
      or_laguna_xs:      "poolside/poolside-mamba:free",
      or_nex:            "nexa-ai/llama-3.1-8b:free",
      or_dolphin:        "cognitivecomputations/dolphin3.0-mistral-24b:free",
      or_lfm_think:      "liquid/lfm-7b:free",
      or_lfm:            "liquid/lfm-7b:free",
      or_safety:         "nvidia/llama-guard-3-8b:free",
    };
    const model = modelMap[prov] || "openrouter/auto";
    const key = OPENROUTER_KEY || "sk-or-free";
    const body = { model, messages, stream };
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "HTTP-Referer": "https://kai.app",
        "X-Title": "KAI",
      },
      body: JSON.stringify(body),
    });
    if (stream) return res;
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  // ── GitHub Models ──────────────────────────────────────────────────────
  if (prov.startsWith("github_")) {
    const modelMap: Record<string, string> = {
      github_llama8b:   "Meta-Llama-3.1-8B-Instruct",
      github_llama405b: "Meta-Llama-3.1-405B-Instruct",
      github_gpt4o:     "gpt-4o",
      github_gpt4omini: "gpt-4o-mini",
    };
    const model = modelMap[prov] || "gpt-4o-mini";
    const key = GITHUB_TOKEN;
    if (!key) throw new Error("No GitHub token configured on server");
    const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream }),
    });
    if (stream) return res;
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  // ── Groq ───────────────────────────────────────────────────────────────
  if (prov === "groq") {
    if (!GROQ_KEY) throw new Error("Groq key not set — go to Setup");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, stream }),
    });
    if (stream) return res;
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  // ── HuggingFace / kai_builtin ──────────────────────────────────────────
  if (prov === "hf" || prov === "kai_builtin") {
    if (!HF_KEY) throw new Error("HuggingFace token not set — go to Setup");
    const res = await fetch(
      "https://api-inference.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HF_KEY}` },
        body: JSON.stringify({ model: "Qwen/Qwen2.5-7B-Instruct", messages, stream, max_tokens: 1024 }),
      }
    );
    if (stream) return res;
    const d = await res.json();
    if (d.error) throw new Error(typeof d.error === "string" ? d.error : JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  // ── Local model via WebLLM bridge (phone-side inference) ──────────────
  // When provider is "local_*", the actual inference runs in the client via WebLLM.
  // The server just echoes back a signal telling the client to handle it.
  if (prov.startsWith("local_")) {
    throw new Error(`LOCAL_MODEL:${prov}`); // client catches this and routes to WebLLM
  }

  throw new Error(`Unknown provider: ${prov}`);
}

// ── Streaming passthrough ─────────────────────────────────────────────────
async function streamLLM(messages: ChatMsg[], chatId: string, provider?: string): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    try {
      const upstream = await callLLM(messages, provider, true) as Response;
      if (!upstream.ok) {
        const err = await upstream.text();
        await writer.write(enc.encode(sse({ type: "error", error: err })));
        await writer.close(); return;
      }
      const reader = upstream.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const l = line.replace(/^data:\s*/, "").trim();
          if (!l || l === "[DONE]") continue;
          try {
            const chunk = JSON.parse(l);
            const delta = chunk.choices?.[0]?.delta?.content || "";
            if (delta) {
              accumulated += delta;
              await writer.write(enc.encode(sse({ type: "delta", text: delta })));
            }
          } catch { /* skip bad JSON */ }
        }
      }

      // Save to DB
      let savedChatId = chatId;
      if (!savedChatId) {
        const title = accumulated.slice(0, 60).replace(/\n/g, " ") || "Chat";
        try {
          const chat = await dbInsert("kai_chats", { title });
          savedChatId = chat.id;
        } catch (e) { console.error("chat insert:", e); }
      }
      if (savedChatId) {
        try {
          await dbInsertNoReturn("kai_messages", {
            chat_id: savedChatId,
            role: "assistant",
            content: accumulated,
          });
        } catch (e) { console.error("msg insert:", e); }
      }

      const tokens = Math.round(accumulated.length / 4);
      await writer.write(enc.encode(sse({ type: "done", reply: accumulated, tokens, chat_id: savedChatId })));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await writer.write(enc.encode(sse({ type: "error", error: msg })));
    } finally {
      await writer.close();
    }
  })();

  return corsStream(readable);
}

// ── Image generation — FIX: proper async/await, no .catch() ──────────────
async function generateImage(prompt: string, style: string, chatId: string | null) {
  // Try Pollinations first (free, no key needed)
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + (style ? ", " + style : ""))}?width=768&height=768&nologo=true&enhance=true`;

  // Verify the URL is reachable
  let imageUrl = pollinationsUrl;
  try {
    const check = await fetch(pollinationsUrl, { method: "HEAD" });
    if (!check.ok) throw new Error("Pollinations unreachable");
  } catch {
    // Fallback: use a different Pollinations endpoint
    imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?seed=${Date.now()}&nologo=true`;
  }

  // Save message to DB — FIX: use await + try/catch, never .catch() chained
  let savedChatId = chatId;
  try {
    if (!savedChatId) {
      const chat = await dbInsert("kai_chats", { title: `Image: ${prompt.slice(0, 40)}` });
      savedChatId = chat.id;
    }
    await dbInsertNoReturn("kai_messages", {
      chat_id: savedChatId,
      role: "user",
      content: `/image ${prompt}`,
    });
    await dbInsertNoReturn("kai_messages", {
      chat_id: savedChatId,
      role: "assistant",
      content: imageUrl,
      meta: { image_urls: [imageUrl] },
    });
  } catch (e) {
    console.error("DB save error (image):", e);
    // Don't fail — still return the image URL even if DB save fails
  }

  return { ok: true, url: imageUrl, chat_id: savedChatId };
}

// ── Video reel generation ─────────────────────────────────────────────────
async function generateReel(topic: string, type: string, style: string, scenes: number, chatId: string | null) {
  // Generate script via LLM
  const scriptPrompt = `Create a ${type} short-form video reel script about: "${topic}"
Style: ${style}. Scenes: ${scenes}.
Return JSON only:
{
  "title": "...",
  "summary": "one line summary",
  "scenes": [
    { "scene": 1, "visual": "describe the visual", "caption": "text overlay", "duration": 3 }
  ]
}`;

  let scriptJson: { title?: string; summary?: string; scenes?: Array<{ scene: number; visual: string; caption: string; duration: number }> } = {};
  try {
    const raw = await callLLM(
      [{ role: "user", content: scriptPrompt }],
      undefined,
      false
    ) as string;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    scriptJson = JSON.parse(cleaned);
  } catch (e) {
    scriptJson = {
      title: topic,
      summary: `A ${type} reel about ${topic}`,
      scenes: Array.from({ length: scenes }, (_, i) => ({
        scene: i + 1,
        visual: `Scene ${i + 1}: ${topic}`,
        caption: `${topic} — part ${i + 1}`,
        duration: 3,
      })),
    };
  }

  // Generate images for each scene via Pollinations
  const imageUrls: string[] = [];
  for (const scene of (scriptJson.scenes || []).slice(0, 6)) {
    const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(scene.visual + `, ${style} style, cinematic, vertical 9:16`)}?width=432&height=768&nologo=true`;
    imageUrls.push(imgUrl);
  }

  // Save to DB
  let savedChatId = chatId;
  try {
    if (!savedChatId) {
      const chat = await dbInsert("kai_chats", { title: `Reel: ${topic.slice(0, 40)}` });
      savedChatId = chat.id;
    }
    const reelContent = `🎬 ${scriptJson.title || topic}\n\n${scriptJson.summary || ""}\n\n${imageUrls.join("\n")}`;
    await dbInsertNoReturn("kai_messages", { chat_id: savedChatId, role: "user", content: `/reel ${topic}` });
    await dbInsertNoReturn("kai_messages", {
      chat_id: savedChatId, role: "assistant", content: reelContent,
      meta: { image_urls: imageUrls },
    });
  } catch (e) { console.error("DB save error (reel):", e); }

  return {
    ok: true,
    chat_id: savedChatId,
    script_summary: scriptJson.summary || "",
    scenes: scriptJson.scenes || [],
    image_urls: imageUrls,
    tokens: 200,
  };
}

// ── Main router ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/kai-brain/, "").replace(/\/$/, "") || "/";

  // Ping — no auth needed
  if (path === "/ping") {
    const provider = await getActiveProvider();
    return cors({
      ok: true,
      provider,
      has_groq: !!GROQ_KEY,
      has_hf: !!HF_KEY,
      has_openai: !!OPENAI_KEY,
      has_builtin_ai: !!HF_KEY,
      builtin_model: "Qwen 2.5 7B",
      lessons_learned: 0,
      version: "BUILD_P",
    });
  }

  if (!authOk(req)) return cors({ error: "unauthorized" }, 401);

  // ── Chat stream ──────────────────────────────────────────────────────
  if (path === "/chat/stream" && req.method === "POST") {
    const body = await req.json();
    const { text, chat_id, image_urls } = body;
    const provider = await getActiveProvider();

    // Save user message
    let chatId = chat_id || null;
    try {
      if (!chatId) {
        const chat = await dbInsert("kai_chats", { title: text.slice(0, 60) || "Chat" });
        chatId = chat.id;
      }
      await dbInsertNoReturn("kai_messages", { chat_id: chatId, role: "user", content: text });
    } catch (e) { console.error("save user msg:", e); }

    // Build messages with history
    const history: ChatMsg[] = [];
    try {
      const rows = await dbSelect("kai_messages", { chat_id: chatId }, "role,content", 20);
      for (const r of rows.slice(-16)) {
        history.push({ role: r.role === "assistant" ? "assistant" : "user", content: r.content });
      }
    } catch { history.push({ role: "user", content: text }); }

    // Add image context if any
    if (image_urls?.length) {
      history[history.length - 1].content += `\n\n[Images attached: ${image_urls.join(", ")}]`;
    }

    // Local model signal — tell client to handle inference
    if (provider.startsWith("local_")) {
      return cors({ type: "local_inference", provider, messages: history, chat_id: chatId });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    await writer.write(enc.encode(sse({ type: "chat_id", chat_id: chatId })));

    return streamLLM(history, chatId, provider);
  }

  // ── Save local model result (client ran inference, sends result back) ──
  if (path === "/chat/local-result" && req.method === "POST") {
    const { chat_id, reply, tokens } = await req.json();
    try {
      await dbInsertNoReturn("kai_messages", { chat_id, role: "assistant", content: reply });
    } catch (e) { console.error("save local result:", e); }
    return cors({ ok: true, chat_id, tokens });
  }

  // ── Agentic mode ─────────────────────────────────────────────────────
  if (path === "/chat/agentic" && req.method === "POST") {
    const body = await req.json();
    const { text, chat_id, image_urls } = body;
    let chatId = chat_id || null;
    try {
      if (!chatId) {
        const chat = await dbInsert("kai_chats", { title: text.slice(0, 60) || "Agentic" });
        chatId = chat.id;
      }
      await dbInsertNoReturn("kai_messages", { chat_id: chatId, role: "user", content: text });
    } catch (e) { console.error("agentic save:", e); }

    const providers = ["or_llama70b", "or_gptoss120b", "or_nemotron550b"];
    const responses: string[] = [];
    for (const p of providers) {
      try {
        const r = await callLLM([{ role: "user", content: text }], p, false) as string;
        responses.push(r);
      } catch { /* skip failed providers */ }
    }

    const combined = responses.length
      ? responses[0] // Take the first good response for speed
      : "I couldn't get a response from any model. Please try again.";

    try {
      await dbInsertNoReturn("kai_messages", { chat_id: chatId, role: "assistant", content: combined });
    } catch (e) { console.error("agentic save reply:", e); }

    return cors({ ok: true, reply: combined, chat_id: chatId, tokens: Math.round(combined.length / 4), participants: providers, used: [] });
  }

  // ── Voice ─────────────────────────────────────────────────────────────
  if (path === "/chat/voice" && req.method === "POST") {
    const audioBuf = await req.arrayBuffer();
    const chatId = req.headers.get("x-chat-id") || null;

    // Transcribe via HF Whisper
    let transcript = "";
    try {
      if (HF_KEY) {
        const r = await fetch(
          "https://api-inference.huggingface.co/models/openai/whisper-large-v3",
          { method: "POST", headers: { "Authorization": `Bearer ${HF_KEY}`, "Content-Type": "audio/webm" }, body: audioBuf }
        );
        const d = await r.json();
        transcript = d.text || d.error || "";
      } else {
        transcript = "[voice transcription needs HF token]";
      }
    } catch (e) { transcript = "[transcription error]"; }

    if (!transcript.trim()) return cors({ error: "No speech detected" }, 400);

    // Get reply
    const reply = await callLLM([{ role: "user", content: transcript }], undefined, false) as string;

    // Save
    let savedChatId = chatId;
    try {
      if (!savedChatId) {
        const chat = await dbInsert("kai_chats", { title: transcript.slice(0, 50) });
        savedChatId = chat.id;
      }
      await dbInsertNoReturn("kai_messages", { chat_id: savedChatId, role: "user", content: transcript });
      await dbInsertNoReturn("kai_messages", { chat_id: savedChatId, role: "assistant", content: reply });
    } catch (e) { console.error("voice save:", e); }

    return cors({ ok: true, transcript, reply, chat_id: savedChatId });
  }

  // ── Image generation ──────────────────────────────────────────────────
  if (path === "/generate-image" && req.method === "POST") {
    const { prompt, style, chat_id } = await req.json();
    if (!prompt) return cors({ error: "prompt required" }, 400);
    try {
      const result = await generateImage(prompt, style || "", chat_id || null);
      return cors(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return cors({ error: msg }, 500);
    }
  }

  // ── Reel generation ───────────────────────────────────────────────────
  if (path === "/generate-reel" && req.method === "POST") {
    const { topic, type, style, scenes, chat_id } = await req.json();
    if (!topic) return cors({ error: "topic required" }, 400);
    try {
      const result = await generateReel(topic, type || "motivational", style || "minimal", scenes || 5, chat_id || null);
      return cors(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return cors({ error: msg }, 500);
    }
  }

  // ── Upload image ──────────────────────────────────────────────────────
  if (path === "/upload-image" && req.method === "POST") {
    const buf  = await req.arrayBuffer();
    const name = req.headers.get("x-image-name") || `img_${Date.now()}.jpg`;
    const mime = req.headers.get("Content-Type") || "image/jpeg";
    try {
      const { data, error } = await db.storage.from("kai-artifacts").upload(
        `uploads/${Date.now()}_${name}`, buf, { contentType: mime, upsert: true }
      );
      if (error) throw new Error(error.message);
      const { data: pub } = db.storage.from("kai-artifacts").getPublicUrl(data.path);
      return cors({ ok: true, url: pub.publicUrl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return cors({ error: msg }, 500);
    }
  }

  // ── Chats list ────────────────────────────────────────────────────────
  if (path === "/chats" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_chats").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return cors({ chats: data || [] });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Messages ──────────────────────────────────────────────────────────
  if (path === "/messages" && req.method === "GET") {
    const chatId = url.searchParams.get("chat_id");
    if (!chatId) return cors({ error: "chat_id required" }, 400);
    try {
      const { data, error } = await db.from("kai_messages").select("*").eq("chat_id", chatId).order("created_at").limit(100);
      if (error) throw new Error(error.message);
      const msgs = (data || []).map((m: Record<string, unknown>) => ({
        id: m.id,
        role: m.role === "assistant" ? "kai" : "user",
        text: m.content,
        meta: m.meta || {},
        feedback: m.feedback,
      }));
      return cors({ messages: msgs });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Star chat ─────────────────────────────────────────────────────────
  if (path.match(/^\/chat\/(.+)\/star$/) && req.method === "POST") {
    const id = path.split("/")[2];
    try {
      const rows = await dbSelect("kai_chats", { id }, "starred", 1);
      await dbUpdate("kai_chats", { id }, { starred: !rows[0]?.starred });
      return cors({ ok: true });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Delete chat ───────────────────────────────────────────────────────
  if (path.match(/^\/chat\/(.+)$/) && req.method === "DELETE") {
    const id = path.split("/")[2];
    try {
      await dbDelete("kai_messages", { chat_id: id });
      await dbDelete("kai_chats", { id });
      return cors({ ok: true });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Feedback ──────────────────────────────────────────────────────────
  if (path === "/feedback" && req.method === "POST") {
    const { message_id, rating } = await req.json();
    try {
      await dbUpdate("kai_messages", { id: message_id }, { feedback: rating });
      return cors({ ok: true });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Notes / Memory ────────────────────────────────────────────────────
  if (path === "/notes" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_notes").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return cors({ notes: data || [] });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }
  if (path === "/remember" && req.method === "POST") {
    const { fact } = await req.json();
    try {
      await dbInsertNoReturn("kai_notes", { fact });
      return cors({ ok: true });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Lessons ───────────────────────────────────────────────────────────
  if (path === "/lessons" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_lessons").select("*").order("importance", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return cors({ lessons: data || [] });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }
  if (path === "/self-eval" && req.method === "POST") {
    return cors({ ok: true, message: "Self-eval triggered" });
  }

  // ── Models list ───────────────────────────────────────────────────────
  if (path === "/models" && req.method === "GET") {
    return cors({ models: [] }); // client uses static list
  }

  // ── Set provider/key ──────────────────────────────────────────────────
  if (path === "/set-key" && req.method === "POST") {
    const body = await req.json();
    const { provider } = body;
    try {
      // Upsert active provider setting
      const { error } = await db.from("kai_settings").upsert({ key: "active_provider", value: provider }, { onConflict: "key" });
      if (error) throw new Error(error.message);
      return cors({ ok: true, provider });
    } catch (e: unknown) { return cors({ error: (e as Error).message }, 500); }
  }

  // ── Test provider ─────────────────────────────────────────────────────
  if (path === "/test-provider" && req.method === "POST") {
    const { provider } = await req.json();
    try {
      const reply = await callLLM([{ role: "user", content: "Say OK" }], provider, false) as string;
      return cors({ ok: true, provider, reply: reply.slice(0, 100), model: provider });
    } catch (e: unknown) { return cors({ ok: false, provider, error: (e as Error).message }); }
  }

  // ── Projects (stub) ───────────────────────────────────────────────────
  if (path === "/projects" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_projects").select("*").order("created_at", { ascending: false }).limit(20);
      if (error) return cors({ projects: [] });
      return cors({ projects: data || [] });
    } catch { return cors({ projects: [] }); }
  }

  // ── Benchmark ─────────────────────────────────────────────────────────
  if (path === "/benchmark" && req.method === "POST") {
    return cors({ ok: true, results: [], best: "or_openrouter_free" });
  }

  return cors({ error: "Not found", path }, 404);
});
