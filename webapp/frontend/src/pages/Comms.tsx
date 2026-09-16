import { useState } from 'react'
import { ValueTile } from '../components/ValueTile'
import { HistoryChart } from '../components/HistoryChart'
import { TimeRangePicker } from '../components/TimeRangePicker'
import type { TimeRange } from '../api'

export function Comms() {
  const [range, setRange] = useState<TimeRange>({})

  return (
    <div className="page">
      <h2>Comunicaciones</h2>

      <div className="panel">
        <div className="panel-title">Enlace</div>
        <div className="grid">
          <ValueTile label="RSSI" channel="sim.coms_rssi" unit=" dBm" decimals={1} />
          <ValueTile label="SNR" channel="sim.coms_snr" unit=" dB" decimals={1} />
          <ValueTile label="BER" channel="sim.coms_ber" decimals={4} />
          <ValueTile label="Uplink Rate" channel="sim.coms_uplink_rate" unit=" bps" decimals={0} />
          <ValueTile label="Downlink Rate" channel="sim.coms_downlink_rate" unit=" bps" decimals={0} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Paquetes / Sesión</div>
        <div className="grid">
          <ValueTile label="Sent" channel="sim.coms_packets_sent" decimals={0} />
          <ValueTile label="Received" channel="sim.coms_packets_received" decimals={0} />
          <ValueTile label="Failed" channel="sim.coms_packets_failed" decimals={0} />
          <ValueTile label="S-band TX Power" channel="sim.coms_sband_tx_power" unit=" dBm" decimals={1} />
          <ValueTile label="PA Temp" channel="sim.coms_pa_temp" unit=" °C" decimals={1} />
          <ValueTile label="DL Success" channel="sim.coms_dl_success" unit=" %" decimals={1} />
          <ValueTile label="Total Data" channel="sim.coms_total_data_mb" unit=" MB" decimals={2} />
          <ValueTile label="TX Duration" channel="sim.coms_tx_duration" unit=" s" decimals={1} />
        </div>
      </div>

      <TimeRangePicker onChange={setRange} />
      <HistoryChart title="RSSI" channel="sim.coms_rssi" color="#22D3EE" unit="dBm" range={range} />
      <HistoryChart title="SNR" channel="sim.coms_snr" color="#F59E0B" unit="dB" range={range} />
    </div>
  )
}
