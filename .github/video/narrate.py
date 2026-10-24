"""Voice-over for a setup video with Gemini Live (reads each line verbatim; no TTS-model daily quota).
  ~/coding/python/gemini-live-bot/.venv/bin/python narrate.py <lines.json> <name> [voice]   -> out/<name>-<i>.wav + out/<name>.json
  ONLY=1 … narrate.py …   re-records line 1 only
lines.json is a list of strings, one per scene.
Run with the gemini-live-bot venv: it has google-genai and the API key (common.load_key)."""
import asyncio, difflib, json, os, re, sys, wave

sys.path.insert(0, os.path.expanduser('~/coding/python/gemini-live-bot'))
from google import genai
from google.genai import types
from common import load_key

DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DIR, 'out')
SRC, NAME = sys.argv[1], sys.argv[2]
VOICE = sys.argv[3] if len(sys.argv) > 3 else 'Kore'
MODEL = 'gemini-3.8-live'
# text per scene; write "re-figma M C P" so it is not read "refig-ma"
LINES = json.load(open(os.path.join(DIR, SRC)))
SYS = ('You are a voice-over narrator for a short product tutorial. Read the user\'s text aloud EXACTLY as written, '
       'word for word, in a clear, friendly, unhurried voice. Do not add, skip or change any word. No greeting, no comments.')


async def take(client, text):
    cfg = types.LiveConnectConfig(
        response_modalities=['AUDIO'],
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE))),
        system_instruction=types.Content(parts=[types.Part(text=SYS)]),
        output_audio_transcription=types.AudioTranscriptionConfig())
    pcm, said = bytearray(), ''
    async with client.aio.live.connect(model=MODEL, config=cfg) as s:
        await s.send_client_content(turns=types.Content(role='user', parts=[types.Part(text=text)]), turn_complete=True)
        async for m in s.receive():
            sc = m.server_content
            if not sc: continue
            for p in (sc.model_turn.parts if sc.model_turn else []) or []:
                if p.inline_data and p.inline_data.data: pcm += p.inline_data.data
            if sc.output_transcription and sc.output_transcription.text: said += sc.output_transcription.text
            if sc.turn_complete: break
    return bytes(pcm), said.strip()


norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())   # letters only: "M C P" may come back as "MCP"


async def main():
    client = genai.Client(api_key=load_key())
    os.makedirs(OUT, exist_ok=True)
    # ONLY=1,4 re-records just those lines and keeps the other takes
    only = {int(x) for x in os.environ.get('ONLY', '').split(',') if x}
    old = {m['i']: m for m in json.load(open(os.path.join(OUT, f'{NAME}.json')))} if only and os.path.exists(os.path.join(OUT, f'{NAME}.json')) else {}
    meta = []
    for i, text in enumerate(LINES):
        if only and i not in only and i in old and old[i]['text'] == text:
            meta.append(old[i]); continue
        best = None
        for attempt in range(3):   # a take can stop early or drift from the text: keep the one that matches
            pcm, said = await take(client, text)
            dur = len(pcm) / 2 / 24000
            sim = difflib.SequenceMatcher(None, norm(text), norm(said)).ratio() if said else 0
            ok = dur >= len(text) / 25 and (sim >= .85 or not said)
            print(f'{i} try{attempt} {dur:.1f}s sim={sim:.2f} "{said[:70]}"')
            if ok and (best is None or sim > best[2]): best = (pcm, dur, sim)
            if ok and sim >= .85: break
        if not best: sys.exit(f'line {i}: no good take')
        with wave.open(os.path.join(OUT, f'{NAME}-{i}.wav'), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(best[0])
        meta.append({'i': i, 'dur': round(best[1], 2), 'text': text})
    json.dump(meta, open(os.path.join(OUT, f'{NAME}.json'), 'w'), indent=1)

asyncio.run(main())
