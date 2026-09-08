import { ValueTile } from '../components/ValueTile'
import { HistoryChart } from '../components/HistoryChart'

export function Dashboard() {
  return (
    <div className="page">
      <h2>Dashboard</h2>

      <div className="grid">
        <ValueTile label="Batt Voltage" channel="sim.eps_batt_voltage" unit=" V" decimals={2} />
        <ValueTile label="Batt Current" channel="sim.eps_batt_current" unit=" A" decimals={2} />
        <ValueTile label="Batt SOC" channel="sim.eps_batt_soc" unit=" %" decimals={0} />
        <ValueTile label="Bus Voltage" channel="sim.eps_bus_voltage" unit=" V" decimals={2} />
        <ValueTile label="OBC CPU Load" channel="sim.obc_cpu_load" unit=" %" decimals={0} />
        <ValueTile label="RSSI" channel="sim.coms_rssi" unit=" dBm" decimals={1} />
        <ValueTile label="SNR" channel="sim.coms_snr" unit=" dB" decimals={1} />
        <ValueTile label="Attitude Error" channel="sim.adcs_attitude_error" unit="°" decimals={2} />
      </div>

      <HistoryChart title="Battery Voltage" channel="sim.eps_batt_voltage" color="#22D3EE" unit="V" />
      <HistoryChart title="Battery Current" channel="sim.eps_batt_current" color="#F59E0B" unit="A" />
    </div>
  )
}
