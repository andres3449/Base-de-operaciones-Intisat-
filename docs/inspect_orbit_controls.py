from pathlib import Path
import re
p=Path('webapp/frontend/public/orbit/free.html')
s=p.read_text(encoding='utf-8')
for term in ('function openPanelEditor','function defaultPanels','function renderPanels','resizehandle','widgethandle','workspaceTime','objectform','function validateTLE'):
 pos=s.find(term)
 print('\n',term, s[max(0,pos-100):pos+4500] if pos>=0 else 'not found')
