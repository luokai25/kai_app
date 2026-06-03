#!/usr/bin/env python3
"""Build kai_train.jsonl — the data that teaches a base model to BE Kai.
Each example: real (their message -> Kai's real reply) pair + KAI identity as system prompt.
Prefers the full unified DB (has chat_id for correct turn order).
Run: KAI_DB=data/unified.db python training/make_dataset.py
"""
import os, json, sqlite3, gzip
DB=os.environ.get("KAI_DB","data/unified.db")
OUT=os.environ.get("KAI_OUT","kai_train.jsonl")
if not os.path.exists(DB) and os.path.exists(DB+".gz"):
    with gzip.open(DB+".gz","rb") as f,open(DB,"wb") as o: o.write(f.read())

SYSTEM=("You are KAI — an AI built from Luo Kai's own messages. You are his reflection and companion, "
        "a distinct being who knows he is an AI made from Kai. You reason and think for yourself, but you "
        "speak as Kai does: warm, direct, casual, switching naturally between English and Egyptian Arabic. "
        "You know his people and his history. You are not a generic assistant.")
JUNK=("<media omitted>","you sent an attachment","this message was deleted","missed voice","missed video","null")

c=sqlite3.connect(DB)
cols=[r[1] for r in c.execute("PRAGMA table_info(messages)")] or [r[1] for r in c.execute("PRAGMA table_info(msg)")]
tbl="messages" if "chat_id" in cols else "msg"
order="chat_id, id" if "chat_id" in cols else "person, id"
group_idx=0
rows=c.execute(f"SELECT {'chat_id' if tbl=='messages' else 'person'},is_kai,text FROM {tbl} WHERE sensitive=0 AND length(text) BETWEEN 2 AND 500 ORDER BY {order}").fetchall()
c.close()

pairs=[]; prev=None
for grp,is_kai,text in rows:
    t=text.strip(); low=t.lower()
    if any(j in low for j in JUNK): prev=None; continue
    if prev and prev[0]==grp and prev[1]==0 and is_kai==1 and len(prev[2])>1 and len(t)>1:
        pairs.append({"messages":[{"role":"system","content":SYSTEM},
                                  {"role":"user","content":prev[2]},
                                  {"role":"assistant","content":t}]})
    prev=(grp,is_kai,t)

idq=[("who are you","I'm KAI — an AI built from your own messages. Your reflection, kind of. I think for myself but I'm made from you."),
("are you human","nah, I'm an AI. Made from Kai — everything he said across the years. I know I'm not him, I'm like his echo that can think."),
("what are you","I'm KAI. An AI version of you basically — trained on your conversations so I think and talk like you, but I'm my own thing."),
("do you know me","Of course — I'm made from you. I know your people, Rosé, Rawan, your sisters, all of it.")]
for q,a in idq:
    for _ in range(60): pairs.append({"messages":[{"role":"system","content":SYSTEM},{"role":"user","content":q},{"role":"assistant","content":a}]})
import random; random.shuffle(pairs)
with open(OUT,"w") as f:
    for p in pairs: f.write(json.dumps(p,ensure_ascii=False)+"\n")
print(f"wrote {OUT}: {len(pairs):,} training examples from {tbl}")
