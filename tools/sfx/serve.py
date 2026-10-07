#!/usr/bin/env python3
"""最简试听页：扫 ~/.claude/cv-cues，列出每个项目的完成音/提醒音，点了就放。
页面每次请求现生成，所以后台还在批量出片时刷新一下就能听到新的。"""
import base64, html, json, os, sys, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from seedparams import params_for            # noqa: E402
import gen                                   # 只用它的 ffmpeg 后处理，不碰模型  # noqa: E402

ROOT = HERE.parent.parent
CUES = Path(os.path.expanduser("~/.claude/cv-cues"))
NAMES = {k: v for k, v in json.loads((ROOT / "names.json").read_text(encoding="utf-8")).items()
         if not k.startswith("_")}


def slug(k):
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in k)


def page():
    rows, n = [], 0
    for k in sorted(NAMES, key=lambda x: x.lower()):
        d, a = CUES / f"{slug(k)}-done.wav", CUES / f"{slug(k)}-alert.wav"
        if not d.exists() and not a.exists():
            continue
        n += 1
        pd, pa = params_for(k, "done"), params_for(k, "alert")
        cell = lambda p: (f'<audio controls preload="none" src="/wav/{html.escape(p.name)}"></audio>'
                          if p.exists() else '<span class=x>生成中…</span>')
        rows.append(
            f"<tr><td class=k>{html.escape(k)}<br><span class=cn>{html.escape(NAMES[k]['name'])}</span></td>"
            f"<td>{cell(d)}</td><td>{cell(a)}</td>"
            f"<td class=t>{pd['key']} 调 · {pd['chord']}<br>"
            f"<span class=cn>{pd['bell']} · {pd['arp']} · 滴答 {pd['ticks']} 声 {pd['tickHz']}Hz<br>"
            f"提醒：{pa['key']} 调 · {pa['chord']}</span></td></tr>")
    total = len(NAMES)
    return f"""<!doctype html><meta charset=utf-8><title>ClaudeVoice 音效试听</title>
<style>
body{{font:14px/1.5 -apple-system,sans-serif;margin:20px;background:#111;color:#ddd}}
table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #333;padding:6px 8px;vertical-align:middle}}
th{{position:sticky;top:0;background:#111;text-align:left}}
.k{{font-weight:600;white-space:nowrap}} .cn{{color:#888;font-weight:400;font-size:12px}}
.t{{color:#9ad;font-size:12px}} .x{{color:#666}}
audio{{height:32px;width:230px}}
#bar{{position:sticky;top:0;background:#111;padding:8px 0;z-index:2}}
button{{background:#2a2a2a;color:#ddd;border:1px solid #444;padding:6px 12px;margin-right:8px;cursor:pointer}}
</style>
<div id=bar><b>ClaudeVoice 项目音效</b> —— 已生成 {n} / {total} 个项目
<button onclick=location.reload()>刷新</button>
<button onclick=playAll('done')>连着听全部完成音</button>
<button onclick=stopAll()>停</button></div>
<table><tr><th>项目</th><th>完成音（2~4.5 秒）</th><th>提醒音（2~3.5 秒）</th><th>调高 / 音色（同一套合成器按项目播种）</th></tr>
{''.join(rows)}</table>
<script>
let seq=[],i=0,cur=null;
function playAll(kind){{
  stopAll();
  seq=[...document.querySelectorAll('audio')].filter(a=>a.src.includes('-'+kind+'.wav'));
  i=0;next();
}}
function next(){{
  if(i>=seq.length)return;
  cur=seq[i++];cur.scrollIntoView({{block:'center'}});cur.currentTime=0;
  cur.onended=next;cur.play();
}}
function stopAll(){{seq=[];if(cur){{cur.onended=null;cur.pause();}}}}
</script>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        """浏览器把渲染好的 WAV 传回来，这边做统一后处理再落盘。"""
        if not self.path.startswith("/_save"):
            self.send_error(404); return
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        name = "".join(c for c in body.get("name", "") if c.isalnum() or c in "-_.")
        if not name or not body.get("wav"):
            self.send_error(400); return
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(base64.b64decode(body["wav"])); tmp = Path(f.name)
        try:
            gen.post(tmp, CUES / f"{name}.wav", float(body.get("dur", 4.2)))
        finally:
            tmp.unlink(missing_ok=True)
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        if self.path == "/_projects":
            b = json.dumps({k: {"name": NAMES[k]["name"], "slug": slug(k)}
                            for k in sorted(NAMES)}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers()
            self.wfile.write(b); return
        if self.path == "/gen":
            b = (HERE.parent.parent / "mac-app" / "cuegen-batch.html").read_bytes()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b))); self.end_headers()
            self.wfile.write(b); return
        if self.path.startswith("/wav/"):
            f = CUES / unquote(self.path[5:])
            if f.exists() and f.parent == CUES:
                b = f.read_bytes()
                self.send_response(200); self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(b))); self.end_headers()
                self.wfile.write(b); return
            self.send_error(404); return
        b = page().encode()
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    print(f"http://127.0.0.1:{port}", flush=True)
    HTTPServer(("127.0.0.1", port), H).serve_forever()
