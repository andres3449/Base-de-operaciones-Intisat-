"""Inspect the delivered reference without printing embedded binary assets."""
from pathlib import Path
import json
import re
import hashlib

source = Path(r'D:\D&S\Downloads\INTISAT_Mission_Control (11).html')
text = source.read_text(encoding='utf-8')
pages, _ = json.JSONDecoder().raw_decode(text.split('const EMBEDDED=', 1)[1])
print('SHA256:', hashlib.sha256(source.read_bytes()).hexdigest())
for key in ('EPS / Thermal', 'ADCS', 'Payload', 'Orbit General'):
    html = pages[key]
    body = html.split('<body', 1)[-1]
    body = re.sub(r'<script[\s\S]*?</script>', '', body)
    body = re.sub(r'<style[\s\S]*?</style>', '', body)
    body = re.sub(r'data:[^\s\"\']+', '[ASSET]', body)
    print('\nBODY', key, body[:14000])
orb = pages['Orbit Passes']
for term in ('OrbitEngine=', 'localStorage', 'fetch(', 'defaultSat', 'const satellites', 'const catalog', 'server', 'saveCatalog', 'intisat'):
    matches = list(re.finditer(re.escape(term), orb))
    print('\nMATCH', term, len(matches))
    for m in matches[:5]:
        print(orb[max(0,m.start()-200):m.start()+500])
root = Path.cwd()
print('\nANCESTOR INSTRUCTIONS')
for folder in (root, *root.parents):
    p = folder / 'AGENTS.md'
    if p.exists():
        print(p, p.read_text(encoding='utf-8'))
print('\nNESTED INSTRUCTIONS')
for p in root.glob('**/AGENTS.md'):
    if 'node_modules' not in p.parts:
        print(p, p.read_text(encoding='utf-8'))
