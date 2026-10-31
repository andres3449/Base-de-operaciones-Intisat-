import { useEffect, useState } from 'react'
import { api, type SatelliteConfig } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Metric, PacketConsole, Panel } from '../components/MissionTelemetry'
import { SpectrumScope } from '../components/SpectrumScope'

export function RadioWorkspace({ diagnostics=false }: {diagnostics?:boolean}){
  const {authenticated}=useAuth()
  const [cfg,setCfg]=useState<SatelliteConfig|null>(null)
  const [range,setRange]=useState({min:-120,max:0})
  useEffect(()=>{let active=true;if(authenticated)api.getSatellite().then(c=>{if(active)setCfg(c)}).catch(()=>{});return()=>{active=false}},[authenticated])
  return <div className="mission-page">{!diagnostics&&<div className="mission-linkbar"><strong>LINK METRICS</strong><Metric label="RSSI" channel="coms_rssi" unit="dBm" /><Metric label="SNR" channel="coms_snr" unit="dB" /><Metric label="Downlink" channel="coms_downlink_rate" unit="bps" decimals={0} /><Metric label="BER" channel="coms_ber" decimals={5} /></div>}<div className="mission-radio"><div className="mission-stack"><Panel title="SAVED RECEIVER PROFILE"><div className="mission-metric"><span>Driver</span><b>{cfg?.reception.driver??'—'}</b></div><div className="mission-metric"><span>Frequency</span><b>{cfg?`${cfg.reception.frequency_mhz} MHz`:'—'}</b></div><div className="mission-metric"><span>Gain</span><b>{cfg?`${cfg.reception.gain_db} dB`:'—'}</b></div><div className="mission-metric"><span>Modulation</span><b>{cfg?.reception.modulation??'—'}</b></div><small>{authenticated?'Saved values; runtime may differ.':'Sign in to inspect the receiver profile.'}</small></Panel><Panel title="RUNTIME READBACK"><p>Not available. Actual frequency and bandwidth are reported with received spectrum frames.</p><small>Symbol rate, deviation, sync and power gate are unknown without runtime readback.</small></Panel><Panel title="WATERFALL LEVELS"><label>Minimum (relative dB)<input type="number" min={-200} max={range.max-1} value={range.min} onChange={e=>{const min=Number(e.target.value);if(min<range.max&&min>=-200)setRange({...range,min})}} /></label><label>Maximum (relative dB)<input type="number" min={range.min+1} max={100} value={range.max} onChange={e=>{const max=Number(e.target.value);if(max>range.min&&max<=100)setRange({...range,max})}} /></label><small>Display scale only; not calibrated dBm.</small></Panel></div><div className="mission-radio-spectrum"><SpectrumScope theme="light" title="RF SPECTRUM & WATERFALL" dbMin={range.min} dbMax={range.max} /></div><PacketConsole title="DECODED PACKETS" sdrOnly /></div></div>
}
export function Comms(){return <RadioWorkspace />}
export function SdrDiagnostico(){return <RadioWorkspace diagnostics />}
