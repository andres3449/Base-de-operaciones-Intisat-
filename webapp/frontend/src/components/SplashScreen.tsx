interface Props {
  visible: boolean
  label: string
}

export function SplashScreen({ visible, label }: Props) {
  return (
    <div className={`splash${visible ? '' : ' splash-hide'}`} aria-hidden={!visible}>
      <div className="splash-logo-ring">
        <img src="/intisat_logo.png" alt="INTISAT" className="splash-logo" />
      </div>
      <div className="splash-title">INTISAT</div>
      <div className="splash-subtitle">Sala de Monitoreo</div>
      <div className="splash-status">{label}</div>
    </div>
  )
}
