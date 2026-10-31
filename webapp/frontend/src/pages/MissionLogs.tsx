import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type HistoryPoint, type MessageEntry } from '../api'
import { PacketConsole, Panel, PayloadImage } from '../components/MissionTelemetry'
import { SpectrumScope } from '../components/SpectrumScope'

function Logs({variables=false}:{variables?:boolean}){
  const [channels,setChannels]=useState<string[]>([])
  const [channel,setChannel]=useState('')
  const [from,setFrom]=useState('')
  const [to,setTo]=useState('')
  const [satellite,setSatellite]=useState('')
  const [source,setSource]=useState('')
  const [type,setType]=useState('')
  const [decoded,setDecoded]=useState('')
  const [rows,setRows]=useState<MessageEntry[]>([])
  const [points,setPoints]=useState<HistoryPoint[]>([])
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)
  const sequence=useRef(0)
  const active=useRef(true)
  useEffect(()=>{active.current=true;return()=>{active.current=false;sequence.current++}},[])
  const date=(s:string)=>s?Date.parse(s+'Z')/1000:undefined
  async function refresh(e?:FormEvent){e?.preventDefault();const seq=++sequence.current;setError('');setLoading(true);try{
    if(from&&to&&date(from)!>date(to)!)throw Error('End must follow start')
    if(variables){if(!channel){setPoints([]);return}const result=await api.history(channel,{from_ts:date(from),to_ts:date(to)},satellite||undefined);if(active.current&&seq===sequence.current)setPoints(result.points)}
    else {const result=await api.messages({from_ts:date(from),to_ts:date(to),satellite_id:satellite||undefined,source:source||undefined,pkt_type:type?Number(type):undefined,decoded:decoded?decoded==='yes':undefined,limit:200});if(active.current&&seq===sequence.current)setRows(result.messages)}
  }catch(e){if(active.current&&seq===sequence.current){setError(String(e));setRows([]);setPoints([])}}finally{if(active.current&&seq===sequence.current)setLoading(false)}}
  useEffect(()=>{if(variables)api.channels().then(r=>{if(active.current){setChannels(r.channels);setChannel(r.channels[0]??'')}}).catch(e=>{if(active.current)setError(String(e))});else void refresh()},[variables])
  useEffect(()=>{if(variables&&channel)void refresh()},[channel])
  return <div className="mission-page mission-logs">{!variables&&<div className="mission-log-top"><PacketConsole title="LIVE EVENTS · MSG / LOG" /><SpectrumScope title="RECEIVER SPECTRUM" theme="light" /><Panel title="LAST RECEIVED IMAGE"><PayloadImage compact /></Panel></div>}<Panel title={variables?'DECODED VARIABLES':'RECEIVED MESSAGES'}><form className="mission-log-filters" onSubmit={refresh}>{variables&&<label>Channel<select value={channel} onChange={e=>setChannel(e.target.value)}><option value="">Select channel</option>{channels.map(c=><option key={c}>{c}</option>)}</select></label>}<label>From (UTC)<input type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>To (UTC)<input type="datetime-local" value={to} onChange={e=>setTo(e.target.value)} /></label><label>Satellite<input value={satellite} onChange={e=>setSatellite(e.target.value)} placeholder="All" /></label>{!variables&&<><label>Source<input value={source} onChange={e=>setSource(e.target.value)} placeholder="All" /></label><label>Packet type<input type="number" value={type} onChange={e=>setType(e.target.value)} /></label><label>Decoded<select value={decoded} onChange={e=>setDecoded(e.target.value)}><option value="">All</option><option value="yes">Yes</option><option value="no">No</option></select></label></>}<button disabled={loading||variables&&!channel}>{loading?'Loading…':'Apply / Refresh'}</button></form>{error&&<p className="config-error" role="alert">{error}</p>}<div className="table-wrap"><table><thead><tr>{(variables?['Timestamp (UTC)','Value']:['Timestamp (UTC)','Satellite','Source','Packet','Decoded','Error','Bytes']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{variables?points.slice().reverse().slice(0,200).map((p,i)=><tr key={i}><td>{new Date(p.ts*1000).toISOString()}</td><td>{p.value}</td></tr>):rows.map((r,i)=><tr key={i}><td>{new Date(r.ts*1000).toISOString()}</td><td>{r.satellite_id||'—'}</td><td>{r.source}</td><td>{r.pkt_type_name||r.pkt_type}</td><td>{r.decoded?'Yes':'No'}</td><td>{r.error||'—'}</td><td>{r.size_bytes}</td></tr>)}{!(variables?points.length:rows.length)&&<tr><td colSpan={variables?2:7}>{loading?'Loading…':error?'Data unavailable':'No records for these filters.'}</td></tr>}</tbody></table></div></Panel></div>
}
export function LogsMensajes(){return <Logs />}
export function LogsVariables(){return <Logs variables />}
