"""Reproducibly extract the isolated orbit renderer from the approved reference.

The application shell, telemetry, settings and logs are React components.
Only the self-contained canvas orbit workstation runs in a document boundary.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil

root = Path(__file__).resolve().parents[1]
source = Path(r'D:\D&S\Downloads\INTISAT_Mission_Control (11).html')
assert hashlib.sha256(source.read_bytes()).hexdigest() == '23cd0caf662dbc8b36ddae11b985c829cbbc5857e879a350cdc03806c19bd06b'
design = root / 'design'
design.mkdir(exist_ok=True)
shutil.copyfile(source, design / 'INTISAT_Mission_Control.html')
shutil.copyfile(source.parent / 'INTISAT_FRONTEND_HANDOFF.md', design / 'INTISAT_FRONTEND_HANDOFF.md')
pages, _ = json.JSONDecoder().raw_decode(source.read_text(encoding='utf-8').split('const EMBEDDED=', 1)[1])
out = root / 'webapp/frontend/public/orbit'
out.mkdir(exist_ok=True)
assets = out / 'assets'
assets.mkdir(exist_ok=True)

for name, slug in [('Orbit General','general'),('Orbit Passes','passes'),('Orbit Calendar','calendar'),('Orbit Free View','free')]:
    html = pages[name]
    # No calls to the optional SQLite prototype server from production.
    start = html.index("if(location.protocol!=='file:'){try{const r=await fetch('/api/orbit/catalog')")
    end = html.index('if(!catalog.satellites.find', start)
    html = html[:start] + html[end:]
    html = html.replace('Open through server.py to save a shared catalog. HTML-only mode stores this browser’s copy.', 'Catalog stored in this browser only. Server persistence is not connected.')
    html = html.replace("name:'INTISAT-1',color:", "name:'INTISAT-1 · DEMO',color:")
    html = html.replace("'intisat-orbit-", "'intisat-mc-orbit-").replace("'intisat-orbital-", "'intisat-mc-orbital-")
    # Preserve one scene clock across all four routes, with no wall-clock fiction.
    bridge = '''<script>
try { const saved=JSON.parse(sessionStorage.getItem('intisat-mc-scene-clock')||'null'); if(saved&&Number.isFinite(saved.time)){time=saved.time;playing=false;} } catch {}
addEventListener('pagehide',()=>{try{sessionStorage.setItem('intisat-mc-scene-clock',JSON.stringify({time}));}catch{}});
</script>'''
    html += bridge
    # Deduplicate the historical NASA texture and bundled library across pages.
    def asset(match):
        import base64
        data = base64.b64decode(match.group(2))
        ext = 'png' if match.group(1) == 'png' else 'jpg'
        filename = hashlib.sha256(data).hexdigest()[:16] + '.' + ext
        (assets / filename).write_bytes(data)
        return '/orbit/assets/' + filename
    html = re.sub(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)', asset, html)
    def library(match):
        code = match.group(1)
        if 'window.OrbitEngine=' not in code:
            return match.group(0)
        filename = 'orbit-vendor-' + hashlib.sha256(code.encode()).hexdigest()[:12] + '.js'
        (assets / filename).write_text(code, encoding='utf-8')
        return '<script src="/orbit/assets/' + filename + '"></script>'
    html = re.sub(r'<script>([\s\S]*?)</script>', library, html)
    (out / (slug + '.html')).write_text(html, encoding='utf-8')
    print(slug, len(html), 'characters')
(out / 'ATTRIBUTION.md').write_text('''# Orbit reference assets

Extracted from the delivered INTISAT Mission Control reference (SHA256
23cd0caf662dbc8b36ddae11b985c829cbbc5857e879a350cdc03806c19bd06b).
Original source and handoff are preserved in /design.

- Satellite.js 7.1.0: MIT, https://github.com/shashwatak/satellite-js
- TopoJSON client: ISC, https://github.com/topojson/topojson-client
- World Atlas: ISC, https://github.com/topojson/world-atlas
- Natural Earth data: public domain.
- NASA Blue Marble historical texture: NASA/Goddard Space Flight Center
  Scientific Visualization Studio; Reto Stockli and NASA Earth Observatory.
  https://svs.gsfc.nasa.gov/2915/

The bundled vendor code is extracted verbatim with any included notices.
Geometry does not account for terrain, refraction, antenna availability or RF
link budget. Default objects are explicitly demonstrations.
''', encoding='utf-8')
