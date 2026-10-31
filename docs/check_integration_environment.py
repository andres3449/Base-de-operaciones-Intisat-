from pathlib import Path
import importlib.util
import shutil

root=Path(__file__).resolve().parents[1]
for name in ('playwright','pytest','fastapi','zmq','httpx'):
    print(name, bool(importlib.util.find_spec(name)))
for name in ('node','npm'):
    print(name, shutil.which(name))
for p in (root/'intisat_sdr/src').glob('*.c'):
    s=p.read_text(encoding='utf-8',errors='replace')
    for term in ('"UPDATE_CONFIG"','"SET_FREQ"','"SET_POWER_GATE"','"GET_STATUS"'):
        pos=s.find(term)
        if pos>=0: print('\n',p.name,term,s[max(0,pos-150):pos+3300])
for name in ('webapp/frontend/src/components/SpectrumScope.tsx','webapp/frontend/src/telemetry/useHistory.ts','webapp/backend/headless_config.py'):
    print('\nFILE',name)
    s=(root/name).read_text(encoding='utf-8')
    print(s if len(s)<6000 else s[-6500:])
print('BROWSER CACHE',list((Path.home()/'AppData/Local/ms-playwright').glob('*')))
