import { useEffect, useState, type FormEvent } from 'react'
import { api, type CommandRef, type OnceSchedule, type RecurringSchedule, type ScheduleResponse } from '../api'
import { Panel } from '../components/MissionTelemetry'
import { TransmitWarning, useSatelliteDriver } from '../components/TransmitWarning'

type Kind='recurring'|'once'
const DAY=86400000
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
function monday(d:Date){const t=new Date(d);t.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));t.setUTCHours(0,0,0,0);return t.getTime()}
const utcInput=(s:string)=>new Date(s).toISOString().slice(0,16)
const utc=(s:string)=>new Date(s+'Z').toISOString()

export function Programacion(){
  const [schedule,setSchedule]=useState<ScheduleResponse>({recurring:[],once:[]})
  const [commands,setCommands]=useState<CommandRef[]>([])
  const [week,setWeek]=useState(()=>monday(new Date()))
  const [kind,setKind]=useState<Kind>('once')
  const [edit,setEdit]=useState<string|null>(null)
  const [command,setCommand]=useState('')
  const [start,setStart]=useState('')
  const [end,setEnd]=useState('')
  const [interval,setIntervalS]=useState(60)
  const [enabled,setEnabled]=useState(false)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const driver=useSatelliteDriver()
  useEffect(()=>{let active=true;const refresh=()=>api.schedule().then(s=>{if(active)setSchedule(s)}).catch(e=>{if(active)setError(String(e))});void refresh();api.commands().then(r=>{if(active)setCommands(r.commands)}).catch(e=>{if(active)setError(String(e))});const id=setInterval(refresh,15000);return()=>{active=false;clearInterval(id)}},[])
  const refresh=async()=>setSchedule(await api.schedule())
  async function save(e:FormEvent){e.preventDefault();setError('');setNotice('');setBusy(true);try{
    if(!command.trim())throw Error('Choose a command')
    if(kind==='recurring'&&(Date.parse(end+'Z')<=Date.parse(start+'Z')||interval<1))throw Error('End must follow start and interval must be positive')
    const body=kind==='recurring'?{command,window_start:utc(start),window_end:utc(end),interval_s:interval,enabled}:{command,fire_at:utc(start),enabled}
    if(edit)await api.updateSchedule(kind,edit,body)
    else if(kind==='recurring')await api.addRecurring(body as Omit<RecurringSchedule,'id'|'last_fired_at'>)
    else await api.addOnce(body as Omit<OnceSchedule,'id'|'fired'>)
    await refresh();setEdit(null);setNotice('Schedule saved on the server.');
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  async function toggle(k:Kind,row:RecurringSchedule|OnceSchedule){setBusy(true);setError('');try{await api.updateSchedule(k,row.id,{enabled:!row.enabled});await refresh()}catch(e){setError(String(e))}finally{setBusy(false)}}
  async function remove(k:Kind,id:string){if(!window.confirm('Delete this scheduled command?'))return;setBusy(true);setError('');try{await api.deleteSchedule(k,id);await refresh();if(edit===id)setEdit(null)}catch(e){setError(String(e))}finally{setBusy(false)}}
  function select(k:Kind,row:RecurringSchedule|OnceSchedule){setKind(k);setEdit(row.id);setCommand(row.command);setEnabled(row.enabled);if('fire_at'in row){setStart(utcInput(row.fire_at));setEnd('')}else{setStart(utcInput(row.window_start));setEnd(utcInput(row.window_end));setIntervalS(row.interval_s)}}
  const rows=[...schedule.recurring.map(row=>({kind:'recurring' as Kind,row})),...schedule.once.map(row=>({kind:'once' as Kind,row}))]
  return <div className="mission-page mission-scheduling"><TransmitWarning schedule={schedule} driver={driver}/><div className="mission-settings-header"><strong>Command scheduling · UTC</strong><button onClick={()=>setWeek(w=>w-7*DAY)}>← Previous</button><button onClick={()=>setWeek(monday(new Date()))}>Today</button><span>{new Date(week).toISOString().slice(0,10)} — {new Date(week+6*DAY).toISOString().slice(0,10)}</span><button onClick={()=>setWeek(w=>w+7*DAY)}>Next →</button></div>{error&&<p className="config-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<div className="mission-schedule-layout"><Panel title="WEEKLY AGENDA"><div className="mission-week">{weekdays.map((day,i)=><div className="mission-weekday" key={day}><header>{day}<b>{new Date(week+i*DAY).getUTCDate()}</b></header><div className="mission-hours">{Array.from({length:24},(_,h)=><div key={h}>{String(h).padStart(2,'0')}:00</div>)}{rows.flatMap(({kind:k,row})=>{const a=Date.parse('fire_at'in row?row.fire_at:row.window_start),b='window_end'in row?Date.parse(row.window_end):a+30*60000,ds=week+i*DAY;if(b<=ds||a>=ds+DAY)return[];return <button key={row.id} onClick={()=>select(k,row)} className={`mission-event ${row.enabled?'':'disabled'}`} style={{top:`${(Math.max(a,ds)-ds)/DAY*100}%`,height:`${Math.max(2,(Math.min(b,ds+DAY)-Math.max(a,ds))/DAY*100)}%`}} title={`${row.command} · ${new Date(a).toISOString()} · ${row.enabled?'Enabled':'Disabled'}`}>{row.command}{!row.enabled?' · disabled':''}</button>})}</div></div>)}</div></Panel>
    <div className="mission-stack"><Panel title={edit?'EDIT SCHEDULED COMMAND':'NEW SCHEDULED COMMAND'}><form className="config-form" onSubmit={save}><label>Schedule type<select disabled={!!edit} value={kind} onChange={e=>setKind(e.target.value as Kind)}><option value="once">Once</option><option value="recurring">Recurring window</option></select></label><label>Command<input required list="command-reference" value={command} onChange={e=>setCommand(e.target.value)} placeholder="Command and arguments" /><datalist id="command-reference">{commands.map(c=><option key={c.name} value={c.name}>{c.syntax}</option>)}</datalist></label><small>{commands.find(c=>c.name===command)?.syntax}</small><label>{kind==='once'?'Execution time (UTC)':'Window start (UTC)'}<input required type="datetime-local" value={start} onChange={e=>setStart(e.target.value)} /></label>{kind==='recurring'&&<><label>Window end (UTC)<input required type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)} /></label><label>Interval (seconds)<input required type="number" min="1" value={interval} onChange={e=>setIntervalS(Number(e.target.value))} /></label></>}<label className="mission-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} />Enabled for execution</label><button className="mission-primary" disabled={busy}>{busy?'Saving…':edit?'Save changes':'Create schedule'}</button>{edit&&<button type="button" onClick={()=>{setEdit(null);setCommand('');setStart('');setEnd('');setEnabled(false)}}>Cancel edit</button>}</form></Panel><Panel title="SAVED COMMANDS"><div className="mission-schedule-list">{rows.length?rows.map(({kind:k,row})=><div key={row.id}><strong>{row.command}</strong><small>{'fire_at'in row?`${row.fire_at}${row.fired?' · fired':''}`:`${row.window_start} · every ${row.interval_s}s`}</small><div className="mission-tools"><button disabled={busy} aria-pressed={row.enabled} onClick={()=>toggle(k,row)}>{row.enabled?'Enabled':'Disabled'}</button><button onClick={()=>select(k,row)}>Edit</button><button disabled={busy} onClick={()=>remove(k,row.id)}>Delete</button></div></div>):<p>No scheduled commands.</p>}</div></Panel></div></div></div>
}
