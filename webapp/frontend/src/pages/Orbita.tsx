import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

const VIEWS: Record<string, { file: string; title: string }> = {
  general: { file: 'general', title: 'Orbital tracking' },
  passes: { file: 'passes', title: 'Pass prediction' },
  sunsync: { file: 'sunsync', title: 'Sun-synchronous orbit' },
  calendar: { file: 'calendar', title: 'Pass calendar' },
  free: { file: 'free', title: 'Free view' },
}
const BG = '#02060b'

// Tab switch = one camera move, not a reload: the outgoing view hides its
// panels and hands its camera pose over (orbit-core.js), the incoming view is
// loaded underneath and the outgoing one fades out once the new one has drawn.
type Frame = { id: number; file: string; state: 'live' | 'loading' | 'leaving' | 'fading' }

export function Orbita() {
  const { pathname } = useLocation()
  const view = VIEWS[pathname.split('/').at(-1) ?? ''] ?? VIEWS.general
  const [frames, setFrames] = useState<Frame[]>([{ id: 0, file: view.file, state: 'live' }])
  const framesRef = useRef(frames)
  framesRef.current = frames
  const els = useRef(new Map<number, HTMLIFrameElement>())
  const seq = useRef(0)

  const reveal = (id: number) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, state: 'live' } : f.state === 'leaving' ? { ...f, state: 'fading' } : f)))
    setTimeout(() => setFrames((fs) => fs.filter((f) => f.state !== 'fading')), 500)
  }

  // route change: ask the current view to leave, then load the new one beneath it
  useEffect(() => {
    const current = framesRef.current.filter((f) => f.state === 'live' || f.state === 'loading').at(-1)
    if (current?.file === view.file) return
    const win = current ? els.current.get(current.id)?.contentWindow : null
    let done = false
    const load = () => {
      if (done) return
      done = true
      const id = ++seq.current
      setFrames((fs) => [...fs.map((f) => (f.state === 'live' || f.state === 'loading' ? { ...f, state: 'leaving' as const } : f)), { id, file: view.file, state: 'loading' }])
      setTimeout(() => { if (framesRef.current.some((f) => f.id === id && f.state === 'loading')) reveal(id) }, 4000)
    }
    const onMsg = (e: MessageEvent) => { if (e.source === win && e.origin === location.origin && e.data?.type === 'orbit-left') load() }
    window.addEventListener('message', onMsg)
    const fallback = setTimeout(load, 700)
    if (win) win.postMessage({ type: 'orbit-leave' }, location.origin)
    else load()
    return () => { window.removeEventListener('message', onMsg); clearTimeout(fallback) }
  }, [view.file])

  // the new view reports its first frame: drop the old one over it
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'orbit-ready') return
      const f = framesRef.current.find((x) => x.state === 'loading' && els.current.get(x.id)?.contentWindow === e.source)
      if (f) reveal(f.id)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <div className="page page-embedded-dashboard" style={{ background: BG }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 'calc(100vh - 93px)', background: BG }}>
        {frames.map((f) => (
          <iframe
            key={f.id}
            ref={(el) => { if (el) els.current.set(f.id, el); else els.current.delete(f.id) }}
            src={`/orbit-ui/${f.file}.html`}
            title={VIEWS[f.file]?.title ?? f.file}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: BG,
              // outgoing view stays on top until the new one has drawn, then fades
              zIndex: f.state === 'leaving' || f.state === 'fading' ? 2 : 1,
              opacity: f.state === 'fading' ? 0 : 1,
              transition: 'opacity 450ms ease',
              pointerEvents: f.state === 'live' ? 'auto' : 'none',
            }}
          />
        ))}
      </div>
    </div>
  )
}
