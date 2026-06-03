# Train KAI's brain on Lightning AI — FREE (80 GPU hrs/month)

KAI becomes: talks like you, knows you and your people, AND reasons/assists.
Everything's written. Your job is sign-in + paste + click. ~3 hours, $0.

## One-time setup (~5 min)
1. Go to **lightning.ai** → **Start free** (no credit card).
2. **Verify your phone** → you get ~80 free GPU hours/month.
   (Tip: a school/work email verifies instantly; others may waitlist.)

## Run it (~5 min of you, then it works alone ~3 hrs)
3. Click **New Studio**.
4. Right-side panel → switch the machine to a **GPU** (L4 / A10G / T4 — any is fine).
5. Upload two files into the Studio (drag-drop into the file panel):
   - `KAI_train_lightning.py`
   - `kai_assistant_train.jsonl`   (your 142,909 blended examples)
6. Open the **Terminal** (bottom panel) and run:
   ```
   python KAI_train_lightning.py
   ```
7. It installs, trains ~2 epochs, merges, and makes a GGUF. Leave it running
   (Lightning keeps background jobs alive — you can close the tab).
8. When done, **download `kai-brain-Q4_K_M.gguf`**. That file IS KAI's brain.
9. Send it back here → I wire it into the app so KAI thinks for real, offline.

## Notes
- Base model: **Qwen2.5-3B-Instruct** — strong reasoning, knows English+Arabic.
  Want it lighter/faster? Edit BASE to `Qwen/Qwen2.5-1.5B-Instruct` in the script.
- This uses ~2-3 of your 80 free hours. Plenty of headroom to retrain later.
- The data blends YOUR 128k conversations with 15k general-assist examples,
  so KAI stays smart and helpful while sounding like you and knowing your life.
- Nothing leaves your control: your data, your model, your download.
