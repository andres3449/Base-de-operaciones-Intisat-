import { ValueTile } from '../components/ValueTile'
import { HistoryChart } from '../components/HistoryChart'

export function EpsThermal() {
  return (
    <div className="page">
      <h2>EPS / Thermal</h2>

      <div className="panel">
        <div className="panel-title">Power (EPS)</div>
        <div className="grid">
          <ValueTile label="Batt Voltage" channel="sim.eps_batt_voltage" unit=" V" />
          <ValueTile label="Batt Current" channel="sim.eps_batt_current" unit=" A" />
          <ValueTile label="Batt Temp" channel="sim.eps_batt_temp" unit=" °C" decimals={1} />
          <ValueTile label="Batt SOC" channel="sim.eps_batt_soc" unit=" %" decimals={0} />
          <ValueTile label="Bus Voltage" channel="sim.eps_bus_voltage" unit=" V" />
          <ValueTile label="Bus Current" channel="sim.eps_bus_current" unit=" A" />
          <ValueTile label="Pwr OBC" channel="sim.eps_pwr_obc" unit=" W" />
          <ValueTile label="Pwr Comms" channel="sim.eps_pwr_comms" unit=" W" />
          <ValueTile label="Pwr ADCS" channel="sim.eps_pwr_adcs" unit=" W" />
          <ValueTile label="Pwr TCS" channel="sim.eps_pwr_tcs" unit=" W" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Paneles solares</div>
        <div className="grid">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <ValueTile key={i} label={`Solar V${i}`} channel={`sim.eps_solar_voltage_${i}`} unit=" V" />
          ))}
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <ValueTile key={i} label={`Solar I${i}`} channel={`sim.eps_solar_current_${i}`} unit=" A" />
          ))}
          <ValueTile label="Solar Total Power" channel="sim.eps_solar_total_power" unit=" W" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Thermal / OBC</div>
        <div className="grid">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <ValueTile key={i} label={`Panel Temp ${i}`} channel={`sim.tcs_panel_temp_${i}`} unit=" °C" decimals={1} />
          ))}
          <ValueTile label="Heater Current" channel="sim.tcs_heater_current" unit=" A" />
          <ValueTile label="OBC CPU Load" channel="sim.obc_cpu_load" unit=" %" decimals={0} />
          <ValueTile label="OBC RAM" channel="sim.obc_ram_usage" unit=" %" decimals={0} />
          <ValueTile label="OBC FS Usage" channel="sim.obc_fs_usage" unit=" %" decimals={0} />
          <ValueTile label="OBC Temp" channel="sim.obc_temp" unit=" °C" decimals={1} />
        </div>
      </div>

      <HistoryChart title="Battery Voltage / Current" channel="sim.eps_batt_voltage" color="#22D3EE" unit="V" />
      <HistoryChart title="Panel Temp 1" channel="sim.tcs_panel_temp_1" color="#EF4444" unit="°C" />
    </div>
  )
}
