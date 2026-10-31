// Shared helpers for the ported Mission Control dashboard tabs
// (dashboard-eps.html, dashboard-adcs.html, dashboard-comms.html,
// dashboard-payload.html). Same-origin fetches against the real backend —
// no simulated/fabricated values. Missing channels render as "—".
(function (global) {
  const STALE_S = 15

  async function latest() {
    try {
      const res = await fetch('/api/telemetry/latest')
      if (!res.ok) return {}
      const { values } = await res.json()
      const now = Date.now() / 1000
      const map = {}
      for (const v of values) {
        if (now - v.ts <= STALE_S) map[v.channel] = v.value
      }
      return map
    } catch {
      return {}
    }
  }

  async function history(channel, minutes) {
    try {
      const res = await fetch(`/api/telemetry/history?channel=${encodeURIComponent(channel)}&minutes=${minutes}`)
      if (!res.ok) return []
      const { points } = await res.json()
      return points
    } catch {
      return []
    }
  }

  function fmt(map, channel, unit, decimals) {
    const v = map[channel]
    return v === undefined ? `— — ${unit}`.trim() : `${v.toFixed(decimals)}${unit ? ' ' + unit : ''}`
  }

  // Draws a real multi-series line chart in the exact axis/grid style used
  // by the reference pages, auto-scaling to the real data range instead of
  // the reference's hardcoded illustrative ranges (those assumed a
  // different power/voltage budget than the real satellite).
  function drawChart(canvasId, seriesData, xLabel, yLabel) {
    const cv = document.getElementById(canvasId)
    if (!cv) return
    const rect = cv.parentElement
    const w = rect.clientWidth
    const h = rect.clientHeight
    const d = window.devicePixelRatio || 1
    cv.width = w * d
    cv.height = h * d
    const c = cv.getContext('2d')
    c.scale(d, d)
    c.clearRect(0, 0, w, h)

    const allPoints = seriesData.flatMap((s) => s.points)
    const L = 45, R = 12, T = 10, B = 34
    const pw = w - L - R, ph = h - T - B
    c.font = '10px Segoe UI, Arial'
    c.fillStyle = '#5371b0'
    c.strokeStyle = '#eaf0f7'

    if (allPoints.length < 2) {
      c.textAlign = 'center'
      c.fillText('Esperando telemetría…', w / 2, h / 2)
      return
    }

    const values = allPoints.map((p) => p.value)
    let min = Math.min(...values), max = Math.max(...values)
    if (min === max) {
      min -= 1
      max += 1
    } else {
      const pad = (max - min) * 0.1
      min -= pad
      max += pad
    }
    const tMin = Math.min(...allPoints.map((p) => p.ts))
    const tMax = Math.max(...allPoints.map((p) => p.ts))

    for (let i = 0; i <= 4; i++) {
      const y = T + (ph * i) / 4
      c.beginPath()
      c.moveTo(L, y)
      c.lineTo(w - R, y)
      c.stroke()
      c.textAlign = 'right'
      c.fillText((max - ((max - min) * i) / 4).toFixed(1), L - 7, y + 3)
    }
    for (let i = 0; i <= 5; i++) {
      const x = L + (pw * i) / 5
      c.beginPath()
      c.moveTo(x, T)
      c.lineTo(x, h - B)
      c.stroke()
      const tAt = tMin + ((tMax - tMin) * i) / 5
      c.textAlign = 'center'
      c.fillText(new Date(tAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x, h - B + 15)
    }
    c.fillText(xLabel, L + pw / 2, h - 3)
    c.save()
    c.translate(11, T + ph / 2)
    c.rotate(-Math.PI / 2)
    c.textAlign = 'center'
    c.fillText(yLabel, 0, 0)
    c.restore()

    c.save()
    c.beginPath()
    c.rect(L, T, pw, ph)
    c.clip()
    for (const s of seriesData) {
      if (s.points.length < 2) continue
      c.strokeStyle = s.color
      c.lineWidth = 1.6
      c.beginPath()
      s.points.forEach((p, i) => {
        const x = L + ((p.ts - tMin) / (tMax - tMin || 1)) * pw
        const y = T + (1 - (p.value - min) / (max - min || 1)) * ph
        i ? c.lineTo(x, y) : c.moveTo(x, y)
      })
      c.stroke()
    }
    c.restore()
  }

  global.IntisatDash = { latest, history, fmt, drawChart }
})(window)
