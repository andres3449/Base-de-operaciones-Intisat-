import { useEffect, useState, type FormEvent } from 'react'
import { api, type DetectedDevice, type SatelliteConfig } from '../api'
import { Panel } from '../components/MissionTelemetry'

const runtimeFields = [
  ['center_freq_hz','Frequency (Hz)'], ['rf_gain_db','RF gain (dB)'], ['symbol_rate_sps','Symbol rate (sym/s)'],
  ['freq_deviation_hz','Frequency deviation (Hz)'], ['rx_bandwidth_hz','RX bandwidth (Hz)'], ['sync_power_gate','Power gate (0 = disabled)'],
  ['modulation_type','Modulation'], ['sync_word','On-air sync (4 hex bytes)'], ['packet_length','Packet length (1–255)'],
]

function RuntimeSettings() {
  const [field,setField]=useState('center_freq_hz')
  const [value,setValue]=useState('')
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  async function apply(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      let parsed: string | number | number[] = value
      if(field==='sync_word') { const hex=value.replace(/\s/g,''); if(!/^[a-f\d]{8}$/i.test(hex)) throw Error('Enter exactly four hexadecimal bytes'); parsed=hex.match(/../g)!.map(s=>parseInt(s,16)) }
      else if(field!=='modulation_type') { parsed=Number(value); if(!value.trim() || !Number.isFinite(parsed)) throw Error('Enter a finite value') }
      const reply=await api.updateRuntime({[field]:parsed})
      if(reply.status!=='acknowledged') throw Error('No acknowledgement received')
      setNotice('SDR acknowledged the request. Hardware readback is unavailable. This change is temporary and is lost on restart.')
    } catch(e) { setError(e instanceof Error?e.message:String(e)) } finally { setBusy(false) }
  }
  return <Panel title="TEMPORARY RUNTIME TUNING"><p>Changes the running receiver. Saved profile values remain separate.</p><form className="config-form" onSubmit={apply}><label>Parameter<select value={field} onChange={e=>{setField(e.target.value);setValue('');setNotice('')}}>{runtimeFields.map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label><label>Requested value{field==='modulation_type'?<select required value={value} onChange={e=>setValue(e.target.value)}><option value="">Select modulation</option>{['2FSK','2GFSK','4FSK','4GFSK'].map(m=><option key={m}>{m}</option>)}</select>:<input required value={value} onChange={e=>setValue(e.target.value)} inputMode={field==='sync_word'?'text':'decimal'} />}</label><button className="mission-primary" disabled={busy}>{busy?'Waiting for SDR…':'Apply temporary change'}</button></form>{notice&&<p role="status">{notice}</p>}{error&&<p className="config-error" role="alert">{error}</p>}<small>Current runtime values: unknown until a readback service is available. Power gate units are not calibrated. Register sync and on-air sync are separate.</small></Panel>
}

export function Config() {
  const [cfg,setCfg]=useState<SatelliteConfig|null>(null)
  const [baseline,setBaseline]=useState('')
  const [devices,setDevices]=useState<DetectedDevice[]>([])
  const [scanned,setScanned]=useState(false)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [restartPending,setRestartPending]=useState(false)
  const [decoder,setDecoder]=useState<string|null>(null)
  useEffect(()=>{let active=true;api.getSatellite().then(c=>{if(active){setCfg(c);setBaseline(JSON.stringify(c))}}).catch(e=>{if(active)setError(String(e))});return()=>{active=false}},[])
  const dirty=!!cfg&&JSON.stringify(cfg)!==baseline
  useEffect(()=>{if(!dirty)return;const leave=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave)},[dirty])
  async function scan(){setBusy('scan');setError('');try{setDevices(await api.scanDevices());setScanned(true)}catch(e){setError(String(e))}finally{setBusy('')}}
  async function save(e:FormEvent){e.preventDefault();if(!cfg)return;setBusy('save');setError('');try{const saved=await api.putSatellite(cfg);setCfg(saved);setBaseline(JSON.stringify(saved));setRestartPending(true);setNotice('Profile saved. Receiver restart required.')}catch(e){setError(String(e))}finally{setBusy('')}}
  async function restart(){if(!window.confirm('Restart the receiver? Reception will be interrupted while the saved profile is loaded.'))return;setBusy('restart');setError('');try{await api.restartSdr();setRestartPending(false);setNotice('Restart requested. Wait for received data to confirm recovery.')}catch(e){setError(String(e))}finally{setBusy('')}}
  async function viewDecoder(){if(decoder!==null){setDecoder(null);return}try{const r=await fetch(api.decoderFileURL());if(!r.ok)throw Error(`Decoder unavailable (${r.status})`);setDecoder(await r.text())}catch(e){setError(String(e))}}
  return <div className="mission-page mission-settings"><div className="mission-settings-header"><strong>SDR & Reception</strong><span>{dirty?'Unsaved changes':restartPending?'Saved · restart pending':cfg?'Saved profile':'Loading profile…'}</span><button onClick={restart} disabled={!!busy||dirty}>{busy==='restart'?'Restarting…':'Restart receiver'}</button></div>{error&&<p role="alert" className="config-error">{error}</p>}{notice&&<p role="status">{notice}</p>}<div className="mission-settings-grid"><div className="mission-stack">
    <Panel title="DETECTED HARDWARE"><div className="mission-tools"><span>{cfg?`Configured driver: ${cfg.reception.driver}`:'Loading…'}</span><button onClick={scan} disabled={!!busy}>{busy==='scan'?'Scanning…':'Scan connected hardware'}</button></div>{devices.map((d,i)=><button key={`${d.driver}-${i}`} className={`mission-device ${cfg?.reception.driver===d.driver?'selected':''}`} disabled={!cfg||!!busy} onClick={()=>cfg&&setCfg({...cfg,reception:{...cfg.reception,driver:d.driver}})}><strong>{d.label}</strong><small>{d.detail}</small></button>)}{!devices.length&&<p>{scanned?'No supported devices reported.':'Scan USB and serial devices to select a reception driver.'}</p>}<small>Selection configures the driver. Serial port / device identity selection is not supported by the current profile API.</small></Panel>
    <Panel title="PERSISTED SATELLITE & RECEPTION PROFILE">{cfg?<form className="config-form mission-profile" onSubmit={save}><label>Satellite ID<input required value={cfg.satellite.id} onChange={e=>setCfg({...cfg,satellite:{...cfg.satellite,id:e.target.value}})} /></label><label>Name<input required value={cfg.satellite.name} onChange={e=>setCfg({...cfg,satellite:{...cfg.satellite,name:e.target.value}})} /></label><label>Framing<select value={cfg.reception.method} onChange={e=>setCfg({...cfg,reception:{...cfg.reception,method:e.target.value}})}>{['uart8a','ax25','ccsds_spp'].map(v=><option key={v}>{v}</option>)}</select></label><label>Modulation<input value={cfg.reception.modulation} onChange={e=>setCfg({...cfg,reception:{...cfg.reception,modulation:e.target.value}})} /></label><label>Frequency (MHz)<input required type="number" min="0.1" step="any" value={cfg.reception.frequency_mhz} onChange={e=>setCfg({...cfg,reception:{...cfg.reception,frequency_mhz:Number(e.target.value)}})} /></label><label>RF gain (dB)<input required type="number" step="any" value={cfg.reception.gain_db} onChange={e=>setCfg({...cfg,reception:{...cfg.reception,gain_db:Number(e.target.value)}})} /></label><label>Si4463 register sync<input required value={cfg.reception.sync_word} onChange={e=>setCfg({...cfg,reception:{...cfg.reception,sync_word:e.target.value}})} /></label><button className="mission-primary" disabled={!!busy||!dirty}>{busy==='save'?'Saving…':'Save profile'}</button></form>:<p>{error?'Profile could not be loaded.':'Loading…'}</p>}<small>Profile changes require restart. Saving register sync does not confirm that it reaches the running SDR.</small></Panel>
  </div><div className="mission-stack"><RuntimeSettings /><Panel title="DECODER DEFINITION"><p>Inspect or download the current decoder definition.</p><div className="mission-tools"><button onClick={viewDecoder}>{decoder!==null?'Hide source':'View source'}</button><a href={api.decoderFileURL()} download="telemetry_assembler.py">Download</a></div>{decoder!==null&&<pre className="decoder-file-view">{decoder}</pre>}</Panel></div></div></div>
}
