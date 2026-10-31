from pathlib import Path
root=Path(__file__).resolve().parents[1]
changes={
 'webapp/frontend/src/pages/Scheduling.tsx': [('setInterval(Number(e.target.value))','setIntervalS(Number(e.target.value))'), ('<select required value={command} onChange={e=>setCommand(e.target.value)}><option value="">Select command</option>{commands.map(c=><option key={c.name} value={c.name}>{c.name}</option>)}{command&&!commands.some(c=>c.name===command)&&<option>{command}</option>}</select>', '<input required list="command-reference" value={command} onChange={e=>setCommand(e.target.value)} placeholder="Command and arguments" /><datalist id="command-reference">{commands.map(c=><option key={c.name} value={c.name}>{c.syntax}</option>)}</datalist>')],
 'webapp/frontend/src/components/MissionTelemetry.tsx': [('if (!paused) frozen.current = entries', 'if (!paused) setFrozen(entries)')],
}
for name,pairs in changes.items():
 p=root/name;s=p.read_text(encoding='utf-8')
 for old,new in pairs:
  assert old in s, (name,old)
  s=s.replace(old,new)
 p.write_text(s,encoding='utf-8')
