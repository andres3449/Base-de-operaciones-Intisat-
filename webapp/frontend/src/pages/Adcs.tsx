import { ValueTile } from '../components/ValueTile'
import { HistoryChart } from '../components/HistoryChart'

export function Adcs() {
  return (
    <div className="page">
      <h2>ADCS</h2>

      <div className="panel">
        <div className="panel-title">Sensores</div>
        <div className="grid">
          <ValueTile label="Mag X" channel="sim.adcs_mag_x" decimals={2} />
          <ValueTile label="Mag Y" channel="sim.adcs_mag_y" decimals={2} />
          <ValueTile label="Mag Z" channel="sim.adcs_mag_z" decimals={2} />
          <ValueTile label="Gyro X" channel="sim.adcs_gyro_x" decimals={2} />
          <ValueTile label="Gyro Y" channel="sim.adcs_gyro_y" decimals={2} />
          <ValueTile label="Gyro Z" channel="sim.adcs_gyro_z" decimals={2} />
          <ValueTile label="Accel X" channel="sim.adcs_accel_x" decimals={3} />
          <ValueTile label="Accel Y" channel="sim.adcs_accel_y" decimals={3} />
          <ValueTile label="Accel Z" channel="sim.adcs_accel_z" decimals={3} />
          <ValueTile label="Sun Angle" channel="sim.adcs_sun_angle" unit="°" decimals={1} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Actitud / Control</div>
        <div className="grid">
          <ValueTile label="Quat W" channel="sim.adcs_quat_w" decimals={4} />
          <ValueTile label="Quat X" channel="sim.adcs_quat_x" decimals={4} />
          <ValueTile label="Quat Y" channel="sim.adcs_quat_y" decimals={4} />
          <ValueTile label="Quat Z" channel="sim.adcs_quat_z" decimals={4} />
          <ValueTile label="Ang Vel X" channel="sim.adcs_ang_vel_x" decimals={3} />
          <ValueTile label="Ang Vel Y" channel="sim.adcs_ang_vel_y" decimals={3} />
          <ValueTile label="Ang Vel Z" channel="sim.adcs_ang_vel_z" decimals={3} />
          <ValueTile label="Attitude Error" channel="sim.adcs_attitude_error" unit="°" decimals={2} />
          <ValueTile label="MTQ Current" channel="sim.adcs_mtq_current" unit=" A" />
          <ValueTile label="RW Speed 1" channel="sim.adcs_rw_speed_1" unit=" RPM" decimals={0} />
          <ValueTile label="RW Speed 2" channel="sim.adcs_rw_speed_2" unit=" RPM" decimals={0} />
          <ValueTile label="RW Speed 3" channel="sim.adcs_rw_speed_3" unit=" RPM" decimals={0} />
          <ValueTile label="RW Torque" channel="sim.adcs_rw_torque" decimals={4} />
        </div>
      </div>

      <HistoryChart title="Attitude Error" channel="sim.adcs_attitude_error" color="#A78BFA" unit="°" />
    </div>
  )
}
