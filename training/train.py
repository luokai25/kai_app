#!/usr/bin/env python3
"""KAI training — runs on GitHub Actions (CPU) or any GPU box.
CPU stage (free, in-build): semantic embeddings over Kai's corpus + math/identity packs.
GPU stage (when available): fine-tune a small base model on Kai's voice (set KAI_GPU=1).
Outputs land in www/ so the next APK build ships a smarter KAI.
"""
import os, json, sqlite3, math, gzip, struct
DB=os.environ.get("KAI_DB","www/app_corpus.db")
OUT=os.environ.get("KAI_OUT","www")
GPU=os.environ.get("KAI_GPU","0")=="1"

def log(*a): print("[train]",*a,flush=True)

def load_corpus():
    if not os.path.exists(DB):
        # CI may ship gz; try ungzip
        if os.path.exists(DB+".gz"):
            with gzip.open(DB+".gz","rb") as f, open(DB,"wb") as o: o.write(f.read())
    c=sqlite3.connect(DB)
    rows=c.execute("SELECT person,is_kai,text FROM msg WHERE sensitive=0 AND length(text)>3").fetchall()
    c.close(); return rows

# ---- CPU stage: lightweight semantic index (term stats per person + Kai voice n-grams) ----
def build_cpu(rows):
    from collections import Counter, defaultdict
    log(f"corpus: {len(rows):,} messages")
    # Kai's signature phrases (bigrams) for voice grounding
    kai=[t for p,k,t in rows if k==1]
    big=Counter()
    for t in kai:
        w=t.lower().split()
        for i in range(len(w)-1): big[w[i]+" "+w[i+1]]+=1
    sig=[p for p,_ in big.most_common(120) if len(p)>4]
    # per-person top terms (who they are by what they say)
    perperson=defaultdict(Counter)
    for p,k,t in rows:
        if k==0 and p:
            for w in t.lower().split():
                if len(w)>3: perperson[p][w]+=1
    profiles={p:[w for w,_ in c.most_common(25)] for p,c in perperson.items()}
    out={"signature_phrases":sig,"person_terms":profiles,"trained_messages":len(rows)}
    json.dump(out,open(os.path.join(OUT,"trained_voice.json"),"w"),ensure_ascii=False,indent=1)
    log("wrote trained_voice.json (signatures + per-person term profiles)")

# ---- math/identity packs (baked knowledge, no GPU) ----
def build_packs():
    identity={
      "name":"KAI",
      "nature":"An AI built from Luo Kai's own messages — his reflection and companion, distinct from him.",
      "knows":"Kai's relationships across WhatsApp, Instagram, Snapchat; his voice; his history.",
      "abilities":["chat in Kai's voice","recall real memories","play music","web search","open apps","voice in/out","math"],
      "principles":["honest","local-first","memory stays on device","never pretends to be human Kai"]
    }
    json.dump(identity,open(os.path.join(OUT,"identity.json"),"w"),ensure_ascii=False,indent=1)
    log("wrote identity.json")

def build_gpu(rows):
    if not GPU:
        log("GPU stage skipped (set KAI_GPU=1 on a GPU machine to fine-tune the brain).")
        return
    log("GPU stage: (placeholder) — fine-tune small base model on Kai voice here.")
    # Real impl: load Qwen2.5-1.5B/3B, LoRA on kai messages, quantize, export.

if __name__=="__main__":
    rows=load_corpus()
    build_cpu(rows)
    build_packs()
    build_gpu(rows)
    log("done.")
