# How to give KAI his real brain (one GPU run)

Everything here is written and ready. Your only job is the one click Claude can't make.

## What you get
A model that **reasons** (handles anything, thinks) **and** is **KAI** — talks like you,
knows your people, knows it's an AI made from you. Runs offline on a laptop afterward.

## Steps (~10 min of your time + a few hours the GPU works on its own)
1. **Get the data file:** Claude generated `kai_train.jsonl` (127k of your real conversation
   turns + identity). It's in the repo / your outputs.
2. Go to **kaggle.com** → sign in → **Create → New Notebook**.
3. **Settings → Accelerator → GPU T4 ×2** (free), and **Internet → ON**.
4. **Add data:** upload `kai_train.jsonl` to the notebook (right panel → Upload).
5. Open `KAI_brain_kaggle.ipynb.py`, copy all of it into a notebook cell.
6. **Run All.** Wait ~2–4 hours (you can close the tab; it keeps running).
7. At the end, **download `kai-brain-Q4_K_M.gguf`** — that file *is* KAI's brain.
8. Send it back here, and Claude wires it into the app so KAI thinks for real.

## Notes
- Base model: Qwen2.5-1.5B-Instruct (good reasoning, multilingual EN+AR, runs on CPU after).
  Want deeper? Change BASE to Qwen2.5-3B-Instruct in the script (needs a bit more time).
- 30 free GPU hours/week on Kaggle — one run is well within that.
- Nothing leaves your control: your data, your model, your download.
