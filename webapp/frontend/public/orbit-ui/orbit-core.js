/* INTISAT orbit workstation — shared engine for the four Orbit views.
 *
 * Physics: two-body Kepler propagation from TLE mean elements plus J2
 * secular drift of RAAN / argument of perigee, rotated to ECEF with the real
 * GMST. No drag, no SGP4 short-period terms: good for pass planning over
 * days, not for precise pointing. Every view labels it as an estimate.
 */
(function (global) {
  'use strict'

  const DEG = Math.PI / 180, RAD = 180 / Math.PI, TWO_PI = 2 * Math.PI
  const MU = 398600.4418, RE = 6371, RE_EQ = 6378.137, J2 = 1.08262668e-3
  const ALT_VISUAL_MULT = 3.6
  const CATALOG_KEY = 'intisat-orbit-catalog-v1'
  const CLOCK_KEY = 'intisat-orbit-clock-v1'
  const TEX = '/orbit-textures/'

  const DEFAULT_TLE = [
    '1 99999U 00000A   24142.13728009  .00000000  00000-0 -80777-5 0    06',
    '2 99999  97.9387  30.3347 0000397  22.1885   7.8749 14.98600522    02',
  ]
  const PALETTE = ['#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#34d399', '#fb7185', '#facc15']

  /* ─────────────────────────── TLE ─────────────────────────── */

  function tleChecksum(line) {
    let sum = 0
    for (let i = 0; i < 68 && i < line.length; i++) {
      const c = line[i]
      if (c >= '0' && c <= '9') sum += +c
      else if (c === '-') sum += 1
    }
    return sum % 10
  }

  function parseTLE(l1, l2, name) {
    l1 = (l1 || '').replace(/\s+$/, '')
    l2 = (l2 || '').replace(/\s+$/, '')
    if (l1[0] !== '1' || l2[0] !== '2') throw new Error('Line 1 must start with "1" and line 2 with "2".')
    if (l1.length < 63 || l2.length < 63) throw new Error('TLE lines are too short (expected 69 columns).')
    const warnings = []
    if (l1.length >= 69 && tleChecksum(l1) !== +l1[68]) warnings.push('line 1 checksum mismatch')
    if (l2.length >= 69 && tleChecksum(l2) !== +l2[68]) warnings.push('line 2 checksum mismatch')
    const norad = l1.substring(2, 7).trim()
    if (l2.substring(2, 7).trim() !== norad) warnings.push('NORAD id differs between lines')
    const epochStr = l1.substring(18, 32).trim()
    const yy = parseInt(epochStr.substring(0, 2), 10)
    const doy = parseFloat(epochStr.substring(2))
    const inc = parseFloat(l2.substring(8, 16))
    const raan = parseFloat(l2.substring(17, 25))
    const ecc = parseFloat('0.' + l2.substring(26, 33).trim())
    const argp = parseFloat(l2.substring(34, 42))
    const m0 = parseFloat(l2.substring(43, 51))
    const mm = parseFloat(l2.substring(52, 63))
    const nums = [yy, doy, inc, raan, ecc, argp, m0, mm]
    if (nums.some((v) => !Number.isFinite(v))) throw new Error('Could not read the orbital elements.')
    if (mm <= 0 || ecc >= 1) throw new Error('Mean motion or eccentricity out of range.')
    const year = yy < 57 ? 2000 + yy : 1900 + yy
    const epochMs = Date.UTC(year, 0, 1) + (doy - 1) * 86400000
    const n = (mm * TWO_PI) / 86400
    const a = Math.pow(MU / (n * n), 1 / 3)
    const i = inc * DEG
    const p = a * (1 - ecc * ecc)
    const k = 1.5 * J2 * Math.pow(RE_EQ / p, 2) * n
    return {
      name: name || 'NORAD ' + norad, norad, tle: [l1, l2], warnings,
      epochMs, n, a, e: ecc, i,
      raan0: raan * DEG, argp0: argp * DEG, m0: m0 * DEG,
      raanDot: -k * Math.cos(i), argpDot: 0.5 * k * (5 * Math.cos(i) ** 2 - 1),
      periodMin: TWO_PI / n / 60, incDeg: inc, meanMotion: mm,
    }
  }

  /* ─────────────────────────── physics ─────────────────────────── */

  function kepler(M, e) {
    let E = e < 0.8 ? M : Math.PI
    for (let k = 0; k < 30; k++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
      E -= d
      if (Math.abs(d) < 1e-12) break
    }
    return E
  }

  function gmst(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451545.0
    const g = (280.46061837 + 360.98564736629 * d) % 360
    return (g < 0 ? g + 360 : g) * DEG
  }

  function eciAt(s, ms) {
    const dt = (ms - s.epochMs) / 1000
    let M = (s.m0 + s.n * dt) % TWO_PI
    if (M < 0) M += TWO_PI
    const O = s.raan0 + s.raanDot * dt, w = s.argp0 + s.argpDot * dt
    const E = kepler(M, s.e)
    const xp = s.a * (Math.cos(E) - s.e), yp = s.a * Math.sqrt(1 - s.e * s.e) * Math.sin(E)
    const cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(s.i), sI = Math.sin(s.i), cW = Math.cos(w), sW = Math.sin(w)
    return [
      (cO * cW - sO * sW * cI) * xp + (-cO * sW - sO * cW * cI) * yp,
      (sO * cW + cO * sW * cI) * xp + (-sO * sW + cO * cW * cI) * yp,
      sW * sI * xp + cW * sI * yp,
    ]
  }

  function ecefAt(s, ms) {
    const [x, y, z] = eciAt(s, ms)
    const th = gmst(ms), c = Math.cos(th), sn = Math.sin(th)
    return [c * x + sn * y, -sn * x + c * y, z]
  }

  function stationEcef(st) {
    const r = RE + (st.altM || 0) / 1000, la = st.lat * DEG, lo = st.lon * DEG
    return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)]
  }

  function look(st, p) {
    const s = stationEcef(st)
    const rx = p[0] - s[0], ry = p[1] - s[1], rz = p[2] - s[2]
    const la = st.lat * DEG, lo = st.lon * DEG
    const south = Math.sin(la) * Math.cos(lo) * rx + Math.sin(la) * Math.sin(lo) * ry - Math.cos(la) * rz
    const east = -Math.sin(lo) * rx + Math.cos(lo) * ry
    const zen = Math.cos(la) * Math.cos(lo) * rx + Math.cos(la) * Math.sin(lo) * ry + Math.sin(la) * rz
    const range = Math.hypot(rx, ry, rz)
    let az = Math.atan2(east, -south) * RAD
    if (az < 0) az += 360
    return { az, el: Math.asin(zen / range) * RAD, range }
  }

  function subPoint(p) {
    const r = Math.hypot(p[0], p[1], p[2])
    return { lat: Math.asin(p[2] / r) * RAD, lon: Math.atan2(p[1], p[0]) * RAD, altitude: r - RE, r }
  }

  /* Sun: Astronomical Almanac low-precision formulae (~0.01° over 1950–2050). */
  const SUN_RATE = 360 / 365.2422 // °/day the mean Sun advances in right ascension
  function sunEci(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451545.0
    const L = (280.460 + 0.9856474 * d) * DEG, g = (357.528 + 0.9856003 * d) * DEG
    const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG
    const eps = (23.439 - 0.0000004 * d) * DEG
    const u = [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)]
    return { u, ra: Math.atan2(u[1], u[0]), dec: Math.asin(u[2]), au: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g) }
  }
  function sunEcef(ms) {
    const u = sunEci(ms).u, th = gmst(ms), c = Math.cos(th), sn = Math.sin(th)
    return [c * u[0] + sn * u[1], -sn * u[0] + c * u[1], u[2]]
  }
  /** Cylindrical Earth shadow: true when p (ECEF km) is in eclipse. */
  function inEclipse(p, sunU) {
    const dot = p[0] * sunU[0] + p[1] * sunU[1] + p[2] * sunU[2]
    if (dot > 0) return false
    return Math.hypot(p[0] - dot * sunU[0], p[1] - dot * sunU[1], p[2] - dot * sunU[2]) < RE_EQ
  }
  /** Sun-synchronous analysis of the orbit plane at `ms`. */
  function sunSync(s, ms) {
    const dt = (ms - s.epochMs) / 1000
    const O = s.raan0 + s.raanDot * dt
    const p = s.a * (1 - s.e * s.e), k = 1.5 * J2 * Math.pow(RE_EQ / p, 2) * s.n
    const raanRate = s.raanDot * RAD * 86400
    const cosReq = -(SUN_RATE * DEG / 86400) / k
    const sun = sunEci(ms)
    const norm = (h) => ((h % 24) + 24) % 24
    const ltan = norm(12 + ((O - sun.ra) * RAD) / 15)
    const h = [Math.sin(O) * Math.sin(s.i), -Math.cos(O) * Math.sin(s.i), Math.cos(s.i)]
    const beta = Math.asin(h[0] * sun.u[0] + h[1] * sun.u[1] + h[2] * sun.u[2]) * RAD
    const alt = s.a - RE_EQ, betaStar = Math.asin(RE_EQ / s.a) * RAD
    const frac = Math.abs(beta) >= betaStar ? 0 : Math.acos(Math.sqrt(alt * alt + 2 * RE_EQ * alt) / (s.a * Math.cos(beta * DEG))) / Math.PI
    return {
      raanRate, sunRate: SUN_RATE, drift: raanRate - SUN_RATE,
      iReq: Math.abs(cosReq) <= 1 ? Math.acos(cosReq) * RAD : NaN,
      // |drift| < 0.01°/d keeps LTAN within ~1 min/month; < 0.1°/d is near-SSO
      sso: Math.abs(raanRate - SUN_RATE) < 0.01 ? 'SSO' : Math.abs(raanRate - SUN_RATE) < 0.1 ? 'NEAR SSO' : 'NOT SSO',
      ltanDriftMinPerMonth: (raanRate - SUN_RATE) * 4 * 30.44,
      ltan, ltdn: norm(ltan + 12), beta, eclipseFrac: frac, eclipseMin: frac * s.periodMin,
    }
  }

  /** Full state used by HUDs and Free View variables. */
  function state(s, st, ms) {
    const p = ecefAt(s, ms)
    const sp = subPoint(p)
    const out = {
      ms, ecef: p, latitude: sp.lat, longitude: sp.lon, altitude: sp.altitude,
      velocity: Math.sqrt(MU * (2 / sp.r - 1 / s.a)), elapsed: (ms - s.epochMs) / 1000,
      elevation: NaN, azimuth: NaN, range: NaN, visible: 0,
      sunlit: inEclipse(p, sunEcef(ms)) ? 0 : 1, beta: sunSync(s, ms).beta,
    }
    if (st) {
      const lk = look(st, p)
      out.elevation = lk.el; out.azimuth = lk.az; out.range = lk.range
      out.visible = lk.el >= (st.mask ?? 5) ? 1 : 0
    }
    return out
  }

  function elAt(s, st, ms) { return look(st, ecefAt(s, ms)).el }

  /** Access windows above the station mask, refined to ~1 s. */
  function predictPasses(s, st, startMs, endMs, stepS) {
    const step = (stepS || 30) * 1000
    const mask = st.mask ?? 5
    endMs = Math.min(endMs, startMs + 40 * 86400000)
    const refine = (a, b) => {
      let ea = elAt(s, st, a) - mask
      for (let k = 0; k < 14; k++) {
        const m = (a + b) / 2, em = elAt(s, st, m) - mask
        if ((em >= 0) === (ea >= 0)) { a = m; ea = em } else b = m
      }
      return (a + b) / 2
    }
    const peak = (c) => {
      let a = Math.max(startMs, c - step), b = Math.min(endMs, c + step)
      for (let k = 0; k < 24; k++) {
        const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3
        if (elAt(s, st, m1) < elAt(s, st, m2)) a = m1; else b = m2
      }
      return (a + b) / 2
    }
    const out = []
    let el = elAt(s, st, startMs), cur = null
    if (el >= mask) cur = { aos: startMs, maxEl: el, tca: startMs, partialStart: true }
    for (let t = startMs + step; t <= endMs; t += step) {
      const e = elAt(s, st, t)
      if (!cur && e >= mask) cur = { aos: refine(t - step, t), maxEl: e, tca: t }
      else if (cur) {
        if (e > cur.maxEl) { cur.maxEl = e; cur.tca = t }
        if (e < mask) { cur.los = refine(t - step, t); out.push(finish(cur)); cur = null }
      }
    }
    if (cur) { cur.los = endMs; cur.partialEnd = true; out.push(finish(cur)) }
    return out
    function finish(p) {
      p.tca = peak(p.tca)
      p.maxEl = elAt(s, st, p.tca)
      p.aosAz = look(st, ecefAt(s, p.aos)).az
      p.losAz = look(st, ecefAt(s, p.los)).az
      p.duration = (p.los - p.aos) / 1000
      return p
    }
  }

  /** Sampled az/el track of a pass, for sky plots. */
  function passTrack(s, st, pass, n) {
    const pts = []
    n = n || 60
    for (let k = 0; k <= n; k++) {
      const t = pass.aos + ((pass.los - pass.aos) * k) / n
      const lk = look(st, ecefAt(s, t))
      pts.push({ t, az: lk.az, el: lk.el })
    }
    return pts
  }

  function groundTrack(s, startMs, endMs, n) {
    const pts = []
    n = n || 120
    for (let k = 0; k <= n; k++) {
      const t = startMs + ((endMs - startMs) * k) / n
      const sp = subPoint(ecefAt(s, t))
      pts.push({ t, lat: sp.lat, lon: sp.lon })
    }
    return pts
  }

  function footprintKm(s, mask) {
    const rho = Math.acos(RE / s.a)
    // central angle to the horizon minus the station elevation mask (approx.)
    const lam = Math.max(0, rho - (mask || 0) * DEG)
    return RE * lam
  }

  /* ─────────────────────────── catalog ─────────────────────────── */

  function defaultCatalog() {
    return {
      satellites: [{ id: 'intisat-1', name: 'INTISAT-1', color: PALETTE[0], tle: DEFAULT_TLE.slice(), reference: true }],
      stations: [{ id: 'gs-lima', name: 'GS-INTISAT · Lima', color: '#22c55e', lat: -12.05, lon: -77.04, altM: 150, mask: 5 }],
      activeSat: 'intisat-1', activeStation: 'gs-lima', hidden: [],
    }
  }

  let catalog = null, parsedCache = new Map()

  function loadCatalog() {
    try {
      const c = JSON.parse(localStorage.getItem(CATALOG_KEY) || 'null')
      if (c && Array.isArray(c.satellites) && c.satellites.length && Array.isArray(c.stations) && c.stations.length) {
        c.hidden = Array.isArray(c.hidden) ? c.hidden : []
        return c
      }
    } catch { /* storage blocked or corrupt — fall back to defaults */ }
    return defaultCatalog()
  }

  function getCatalog() { if (!catalog) catalog = loadCatalog(); return catalog }
  function saveCatalog() {
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)) } catch { /* not persisted */ }
    listeners.forEach((fn) => fn(catalog))
  }
  const listeners = []
  function onCatalog(fn) { listeners.push(fn); return () => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1) } }

  function satellites() {
    const c = getCatalog()
    return c.satellites.map((rec) => {
      const key = rec.id + '|' + rec.tle.join('|') + '|' + rec.name
      let s = parsedCache.get(key)
      if (!s) {
        try { s = Object.assign(parseTLE(rec.tle[0], rec.tle[1], rec.name), rec, { ok: true }) }
        catch (err) { s = Object.assign({}, rec, { ok: false, error: err.message }) }
        parsedCache.set(key, s)
      }
      return s
    })
  }
  function validSatellites() { return satellites().filter((s) => s.ok) }
  function stations() { return getCatalog().stations }
  function satById(id) { return satellites().find((s) => s.id === id && s.ok) }
  function stationById(id) { return stations().find((s) => s.id === id) }
  function activeSat() { return satById(getCatalog().activeSat) || validSatellites()[0] }
  function activeStation() { return stationById(getCatalog().activeStation) || stations()[0] }
  function setActiveSat(id) { getCatalog().activeSat = id; saveCatalog() }
  function setActiveStation(id) { getCatalog().activeStation = id; saveCatalog() }
  function isHidden(id) { return getCatalog().hidden.includes(id) }
  function setHidden(id, hidden) {
    const c = getCatalog()
    c.hidden = c.hidden.filter((x) => x !== id)
    if (hidden) c.hidden.push(id)
    saveCatalog()
  }
  function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8) }

  function addSatellite(name, l1, l2, color) {
    const parsed = parseTLE(l1, l2, name)
    const c = getCatalog()
    const rec = { id: uid('sat'), name: name || parsed.name, color: color || PALETTE[c.satellites.length % PALETTE.length], tle: [parsed.tle[0], parsed.tle[1]] }
    c.satellites.push(rec)
    saveCatalog()
    return { rec, parsed }
  }
  function updateSatelliteTLE(id, l1, l2) {
    const parsed = parseTLE(l1, l2)
    const rec = getCatalog().satellites.find((s) => s.id === id)
    if (!rec) throw new Error('Satellite not found.')
    rec.tle = [parsed.tle[0], parsed.tle[1]]
    rec.reference = false
    saveCatalog()
    return parsed
  }
  function removeSatellite(id) {
    const c = getCatalog()
    if (c.satellites.length <= 1) throw new Error('At least one satellite must remain.')
    c.satellites = c.satellites.filter((s) => s.id !== id)
    if (c.activeSat === id) c.activeSat = c.satellites[0].id
    saveCatalog()
  }
  function validateStation(st) {
    const lat = +st.lat, lon = +st.lon, altM = +st.altM, mask = +st.mask
    if (!st.name || !String(st.name).trim()) throw new Error('Station name is required.')
    if (!(lat >= -90 && lat <= 90)) throw new Error('Latitude must be between -90 and 90.')
    if (!(lon >= -180 && lon <= 180)) throw new Error('Longitude must be between -180 and 180.')
    if (!(altM >= -500 && altM <= 9000)) throw new Error('Altitude must be between -500 and 9000 m.')
    if (!(mask >= 0 && mask <= 45)) throw new Error('Elevation mask must be between 0 and 45°.')
    return { name: String(st.name).trim(), lat, lon, altM, mask }
  }
  function addStation(st) {
    const v = validateStation(st)
    const c = getCatalog()
    const rec = Object.assign({ id: uid('gs'), color: st.color || '#22c55e' }, v)
    c.stations.push(rec)
    saveCatalog()
    return rec
  }
  function updateStation(id, st) {
    const v = validateStation(st)
    const rec = getCatalog().stations.find((s) => s.id === id)
    if (!rec) throw new Error('Station not found.')
    Object.assign(rec, v, st.color ? { color: st.color } : {})
    saveCatalog()
    return rec
  }
  function removeStation(id) {
    const c = getCatalog()
    if (c.stations.length <= 1) throw new Error('At least one ground station must remain.')
    c.stations = c.stations.filter((s) => s.id !== id)
    if (c.activeStation === id) c.activeStation = c.stations[0].id
    saveCatalog()
  }

  /* ─────────────────────────── scene clock ─────────────────────────── */
  // Shared across the four views (sessionStorage), so jumping in Passes and
  // switching to General keeps the same scene time.

  const clock = { t: Date.now(), speed: 1, playing: true }
  try {
    const c = JSON.parse(sessionStorage.getItem(CLOCK_KEY) || 'null')
    if (c && Number.isFinite(c.t) && Number.isFinite(c.wall)) {
      clock.speed = c.speed || 1
      clock.playing = c.playing !== false
      clock.t = c.t + (clock.playing ? (Date.now() - c.wall) * clock.speed : 0)
    }
  } catch { /* default to real time */ }
  let lastPersist = 0
  function persistClock() {
    try { sessionStorage.setItem(CLOCK_KEY, JSON.stringify({ t: clock.t, speed: clock.speed, playing: clock.playing, wall: Date.now() })) } catch { /* ignore */ }
  }
  function tick(dtMs) {
    if (clock.playing) clock.t += dtMs * clock.speed
    const now = Date.now()
    if (now - lastPersist > 1000) { lastPersist = now; persistClock() }
    return clock.t
  }
  function setTime(ms) { clock.t = ms; persistClock(); clockListeners.forEach((fn) => fn(clock)) }
  function setSpeed(sp) { clock.speed = sp; clock.playing = true; persistClock(); clockListeners.forEach((fn) => fn(clock)) }
  function setPlaying(p) { clock.playing = p; persistClock(); clockListeners.forEach((fn) => fn(clock)) }
  function liveNow() { clock.t = Date.now(); clock.speed = 1; clock.playing = true; persistClock(); clockListeners.forEach((fn) => fn(clock)) }
  const clockListeners = []
  function onClock(fn) { clockListeners.push(fn) }
  addEventListener('pagehide', persistClock)

  /* ─────────────────────────── formulas ─────────────────────────── */

  const VARIABLES = {
    altitude: 'km', latitude: '°', longitude: '°', elevation: '°', azimuth: '°',
    range: 'km', velocity: 'km/s', visible: '0/1', elapsed: 's', sunlit: '0/1', beta: '°',
  }
  const FUNCS = { abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log, exp: Math.exp, min: Math.min, max: Math.max }

  function compileExpr(src) {
    const toks = []
    const re = /\s*(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),])/y
    let m, pos = 0
    src = String(src || '').trim()
    if (!src) throw new Error('Expression is empty.')
    while (pos < src.length) {
      re.lastIndex = pos
      m = re.exec(src)
      if (!m || m[0].length === 0) throw new Error('Unexpected character at position ' + (pos + 1) + '.')
      toks.push(m[1])
      pos = re.lastIndex
    }
    let i = 0
    const peek = () => toks[i], next = () => toks[i++]
    const expect = (t) => { if (next() !== t) throw new Error('Expected "' + t + '".') }
    function expr() { let n = term(); while (peek() === '+' || peek() === '-') { const op = next(), r = term(), l = n; n = op === '+' ? (e) => l(e) + r(e) : (e) => l(e) - r(e) } return n }
    function term() { let n = unary(); while (peek() === '*' || peek() === '/') { const op = next(), r = unary(), l = n; n = op === '*' ? (e) => l(e) * r(e) : (e) => l(e) / r(e) } return n }
    function unary() { if (peek() === '-') { next(); const u = unary(); return (e) => -u(e) } if (peek() === '+') { next(); return unary() } return power() }
    function power() { const b = primary(); if (peek() === '^') { next(); const x = unary(); return (e) => Math.pow(b(e), x(e)) } return b }
    function primary() {
      const t = next()
      if (t === undefined) throw new Error('Unexpected end of expression.')
      if (t === '(') { const n = expr(); expect(')'); return n }
      if (/^[\d.]/.test(t)) { const v = parseFloat(t); return () => v }
      if (/^[A-Za-z_]/.test(t)) {
        if (peek() === '(') {
          const fn = FUNCS[t]
          if (!fn) throw new Error('Unknown function "' + t + '".')
          next()
          const args = []
          if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()) } }
          expect(')')
          return (e) => fn(...args.map((a) => a(e)))
        }
        if (t === 'pi') return () => Math.PI
        if (!(t in VARIABLES)) throw new Error('Unknown variable "' + t + '".')
        return (e) => e[t]
      }
      throw new Error('Unexpected "' + t + '".')
    }
    const fn = expr()
    if (i < toks.length) throw new Error('Unexpected "' + toks[i] + '".')
    return fn
  }

  /* ─────────────────────────── formatting ─────────────────────────── */

  const pad = (n) => String(n).padStart(2, '0')
  function utcTime(ms) { const d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) }
  function utcHM(ms) { const d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) }
  function utcDate(ms) { return new Date(ms).toISOString().slice(0, 10) }
  function utcStamp(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }
  function dur(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m + 'm ' + pad(s % 60) + 's' }
  function relTime(ms, ref) {
    const s = Math.round((ms - ref) / 1000), a = Math.abs(s)
    const txt = a < 3600 ? Math.floor(a / 60) + 'm ' + pad(a % 60) + 's' : Math.floor(a / 3600) + 'h ' + pad(Math.floor((a % 3600) / 60)) + 'm'
    return s >= 0 ? 'in ' + txt : txt + ' ago'
  }
  function elClass(el) { return el >= 45 ? 'el-hi' : el >= 20 ? 'el-mid' : 'el-lo' }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
  function epochAgeDays(s, ms) { return (ms - s.epochMs) / 86400000 }

  /* ─────────────────────────── shell header ─────────────────────────── */

  function mountHeader(el, title) {
    el.classList.add('shell-header')
    el.innerHTML =
      '<div class="brand"><img class="brand-logo" src="/intisat_logo.png" alt="INTISAT mission patch"><div><div class="brand-title">INTISAT OPERATIONS</div><div class="brand-sub">Ground station · LEO tracking</div></div></div>' +
      '<h1 class="main-title">' + esc(title) + '</h1>' +
      '<div class="status-bar"><div class="link-badge" id="link-badge" title="Telemetry reception state from the backend"><span class="dot"></span><span id="link-text">NO SIGNAL</span></div>' +
      '<div class="scene-clock mono"><small id="clock-label">SCENE TIME · UTC</small><b id="clock-text">--:--:--</b></div></div>'
    let freq = null
    const refresh = async () => {
      try {
        if (freq === null) {
          const r = await fetch('/api/satellite')
          freq = r.ok ? (await r.json()).reception.frequency_mhz : undefined
        }
      } catch { freq = undefined }
      let live = false
      try {
        const r = await fetch('/api/status')
        if (r.ok) { const s = await r.json(); live = s.seconds_since_last_frame != null && s.seconds_since_last_frame <= 30 }
      } catch { /* backend unavailable */ }
      const badge = document.getElementById('link-badge')
      badge.classList.toggle('live', live)
      document.getElementById('link-text').textContent = (live ? 'RECEIVING' : 'NO SIGNAL') + (freq ? ' · ' + freq + ' MHz' : '')
    }
    refresh()
    setInterval(refresh, 5000)
  }

  function updateHeaderClock(ms) {
    const label = document.getElementById('clock-label'), text = document.getElementById('clock-text')
    if (!label) return
    const offset = ms - Date.now()
    const live = Math.abs(offset) < 5000 && clock.speed === 1 && clock.playing
    label.textContent = live ? 'SCENE TIME · UTC · LIVE' : 'SCENE TIME · UTC · ' + (clock.playing ? clock.speed + '×' : 'PAUSED')
    text.textContent = utcDate(ms).slice(5) + ' ' + utcTime(ms)
    text.classList.toggle('sim', !live)
  }

  function mountBridgeBadge(el) {
    const refresh = async () => {
      let txt = 'Telemetry bridge unavailable', ok = false
      try {
        const r = await fetch('/api/status')
        if (r.ok) { const s = await r.json(); ok = !!s.zmq_connected; txt = 'Telemetry bridge ' + (ok ? 'connected' : 'disconnected') }
      } catch { /* backend down */ }
      el.innerHTML = '<span class="tag ' + (ok ? 'tag-live' : 'tag-off') + '">' + (ok ? 'BRIDGE' : 'OFFLINE') + '</span><span class="muted" style="font-size:9px">' + txt + '</span>'
    }
    el.style.cssText += ';display:flex;align-items:center;gap:7px;padding:6px 9px'
    refresh()
    setInterval(refresh, 5000)
  }

  /* ─────────────────────────── time panel ─────────────────────────── */

  function mountTimePanel(el, opts) {
    opts = opts || {}
    el.innerHTML =
      '<div class="time-grid">' +
      ['-1h', '+1h', '+6h', '+12h', '+1d', '+7d'].map((j) => '<button class="btn" data-jump="' + j + '">' + j.replace('d', ' d').replace('h', ' h') + '</button>').join('') +
      '</div><div class="speed-row"><button class="btn" data-play>⏸ Pause</button>' +
      (opts.speeds || [1, 60, 600]).map((s) => '<button class="btn" data-speed="' + s + '">' + (s >= 86400 ? s / 86400 + ' d/s' : s >= 3600 ? s / 3600 + ' h/s' : s + '×') + '</button>').join('') +
      '</div><button class="btn primary block" data-now>▶ NOW · REAL TIME</button>' +
      '<div class="date-row"><input type="datetime-local" step="60" data-date aria-label="Scene time (UTC)"><button class="btn" data-go>GO</button></div>' +
      '<div class="time-status" data-status></div>'
    const status = el.querySelector('[data-status]')
    const sync = () => {
      el.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', clock.playing && clock.speed === +b.dataset.speed))
      el.querySelector('[data-play]').textContent = clock.playing ? '⏸ Pause' : '▶ Play'
    }
    el.querySelectorAll('[data-jump]').forEach((b) => b.onclick = () => {
      const j = b.dataset.jump, v = parseFloat(j), unit = j.slice(-1)
      setTime(clock.t + v * (unit === 'd' ? 86400000 : 3600000))
      status.textContent = '→ ' + utcStamp(clock.t)
      opts.onJump && opts.onJump(clock.t)
    })
    el.querySelectorAll('[data-speed]').forEach((b) => b.onclick = () => { setSpeed(+b.dataset.speed); sync() })
    el.querySelector('[data-play]').onclick = () => { setPlaying(!clock.playing); sync() }
    el.querySelector('[data-now]').onclick = () => { liveNow(); status.textContent = '→ live'; sync(); opts.onJump && opts.onJump(clock.t) }
    el.querySelector('[data-go]').onclick = () => {
      const v = el.querySelector('[data-date]').value
      if (!v) { status.textContent = 'Pick a UTC date/time first.'; return }
      const ms = Date.parse(v + ':00Z')
      if (!Number.isFinite(ms)) { status.textContent = 'Invalid date.'; return }
      setTime(ms)
      status.textContent = '→ ' + utcStamp(ms)
      opts.onJump && opts.onJump(ms)
    }
    onClock(sync)
    sync()
  }

  /* ─────────────────────────── globe ─────────────────────────── */

  function toScene(p, exaggerate) {
    let x = p[0], y = p[1], z = p[2]
    if (exaggerate) {
      const r = Math.hypot(x, y, z), k = (RE + (r - RE) * ALT_VISUAL_MULT) / r
      x *= k; y *= k; z *= k
    }
    return new THREE.Vector3(x, z, -y)
  }
  function llScene(lat, lon, r) {
    const la = lat * DEG, lo = lon * DEG
    return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo))
  }

  let sharedTex = null, texPending = 0
  function textures() {
    if (sharedTex) return sharedTex
    const L = new THREE.TextureLoader(), done = () => { texPending-- }
    const load = (f) => { texPending++; return L.load(TEX + f, done, undefined, done) }
    sharedTex = { day: load('earth-day.jpg'), clouds: load('earth-clouds.png'), spec: load('earth-spec.jpg') }
    sharedTex.day.anisotropy = 8; sharedTex.clouds.anisotropy = 4; sharedTex.spec.anisotropy = 4
    return sharedTex
  }

  // CubeSat-style model: anodised body, gold top deck, two deployable wings, antenna.
  // Scene units are km; the model is shown enlarged so it reads at globe scale.
  function satModel() {
    const g = new THREE.Group()
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, metalness: 0.75, roughness: 0.38 })
    const frame = new THREE.MeshStandardMaterial({ color: 0x5b6773, metalness: 0.6, roughness: 0.45 })
    const gold = new THREE.MeshStandardMaterial({ color: 0xc89b3c, metalness: 0.85, roughness: 0.32 })
    const cells = new THREE.MeshStandardMaterial({ color: 0x14306b, metalness: 0.35, roughness: 0.25, emissive: 0x050c1e })
    g.add(new THREE.Mesh(new THREE.BoxGeometry(70, 70, 140), metal))
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 146), frame); rail.position.set(sx * 34, sy * 34, 0); g.add(rail) }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(66, 66, 6), gold); deck.position.z = -72; g.add(deck)
    for (const s of [-1, 1]) {
      const wing = new THREE.Group()
      for (let k = 0; k < 3; k++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(62, 3, 132), cells); p.position.x = s * (44 + k * 66); wing.add(p)
        const f = new THREE.Mesh(new THREE.BoxGeometry(64, 2, 134), frame); f.position.set(s * (44 + k * 66), -2, 0); wing.add(f)
      }
      const hinge = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 20), frame); hinge.position.x = s * 38; wing.add(hinge)
      g.add(wing)
    }
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 90, 6), frame); ant.rotation.x = Math.PI / 2; ant.position.set(0, 0, 112); g.add(ant)
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(18, 10, 8, 16), metal); dish.rotation.x = Math.PI / 2; dish.position.set(0, 0, 74); g.add(dish)
    return g
  }

  function createGlobe(container, opts) {
    opts = Object.assign({ stars: true, intro: true, distance: 19500, minDist: 8200, maxDist: 90000 }, opts)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 1, 400000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    container.appendChild(renderer.domElement)
    const labelsLayer = document.createElement('div')
    labelsLayer.className = 'globe-labels'
    container.appendChild(labelsLayer)

    const resize = () => {
      const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      frameCamera(camera, container, opts.frame, opts.frameDy)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    if (opts.frame) ro.observe(opts.frame)
    resize()

    const ambient = new THREE.AmbientLight(0xffffff, 0.95)
    scene.add(ambient)
    const sun = new THREE.DirectionalLight(0xdbeafe, 1.35)
    sun.position.set(26000, 10000, 16000)
    scene.add(sun)
    // real Sun direction: lit hemisphere, terminator circle, Sun marker
    let sunOn = opts.sun === true
    const terminator = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.55 }))
    const sunMark = new THREE.Mesh(new THREE.SphereGeometry(900, 20, 16), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }))
    scene.add(terminator, sunMark)
    let sunLabel = null, sunStamp = -Infinity
    function updateSun(ms) {
      terminator.visible = sunMark.visible = sunOn
      ambient.intensity = sunOn ? 0.28 : 0.95
      sun.intensity = sunOn ? 1.8 : 1.35
      if (!sunOn) { sun.position.set(26000, 10000, 16000); return }
      const v = toScene(sunEcef(ms), false).normalize()
      sun.position.copy(v.clone().multiplyScalar(60000))
      sunMark.position.copy(v.clone().multiplyScalar(52000))
      if (Math.abs(ms - sunStamp) > 60000) {
        sunStamp = ms
        const a = new THREE.Vector3(0, 1, 0).cross(v)
        if (a.lengthSq() < 1e-6) a.set(1, 0, 0)
        a.normalize()
        const b = v.clone().cross(a).normalize(), pts = []
        for (let k = 0; k <= 180; k++) { const th = (k / 180) * TWO_PI; pts.push(a.clone().multiplyScalar(Math.cos(th)).add(b.clone().multiplyScalar(Math.sin(th))).multiplyScalar(RE + 14)) }
        terminator.geometry.dispose()
        terminator.geometry = new THREE.BufferGeometry().setFromPoints(pts)
      }
    }

    if (opts.stars) {
      const N = 2600, pos = new Float32Array(N * 3)
      for (let k = 0; k < N; k++) {
        const r = 140000 + Math.random() * 90000, th = Math.random() * TWO_PI, ph = Math.acos(2 * Math.random() - 1)
        pos[k * 3] = r * Math.sin(ph) * Math.cos(th); pos[k * 3 + 1] = r * Math.cos(ph); pos[k * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 90, color: 0x8ea3b5, transparent: true, opacity: 0.55, depthWrite: false })))
    }

    const tex = textures()
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(RE, 96, 64), new THREE.MeshPhongMaterial({ map: tex.day, specularMap: tex.spec, specular: new THREE.Color(0x1f3a52), shininess: 10 })))
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.008, 72, 48), new THREE.MeshLambertMaterial({ map: tex.clouds, transparent: true, opacity: 0.55, depthWrite: false }))
    scene.add(clouds)
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(RE * 1.045, 64, 48), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.16, side: THREE.BackSide })))

    const grid = new THREE.Group()
    const gridMat = new THREE.LineBasicMaterial({ color: 0x3a5a82, transparent: true, opacity: 0.12 })
    for (let la = -60; la <= 60; la += 30) { const p = []; for (let l = 0; l <= 361; l += 2) p.push(llScene(la, l, RE + 4)); grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), gridMat)) }
    for (let lo = 0; lo < 360; lo += 30) { const p = []; for (let la = -90; la <= 90; la += 3) p.push(llScene(la, lo, RE + 4)); grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), gridMat)) }
    scene.add(grid)

    const sats = new Map(), sts = new Map()
    let labelsOn = true, trackLine = null

    function label(text, color, cls) {
      const el = document.createElement('div')
      el.className = 'globe-label' + (cls ? ' ' + cls : '')
      el.style.setProperty('--c', color)
      el.textContent = text
      labelsLayer.appendChild(el)
      return el
    }

    function sync() {
      const list = validSatellites(), slist = stations()
      for (const [id, v] of sats) if (!list.find((s) => s.id === id)) { scene.remove(v.group); scene.remove(v.ring); v.label.remove(); v.link && scene.remove(v.link); sats.delete(id) }
      for (const s of list) {
        let v = sats.get(s.id)
        if (!v) {
          const group = new THREE.Group()
          group.add(satModel())
          scene.add(group)
          const ring = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: s.color, transparent: true, opacity: 0.65 }))
          scene.add(ring)
          const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.7 }))
          link.visible = false
          scene.add(link)
          v = { group, ring, link, label: label(s.name, s.color), stamp: -Infinity, key: '' }
          sats.set(s.id, v)
        }
        v.sat = s
        v.ring.material.color.set(s.color)
        v.label.textContent = s.name
        v.label.style.setProperty('--c', s.color)
        if (v.key !== s.tle.join()) { v.key = s.tle.join(); v.stamp = -Infinity }
      }
      for (const [id, v] of sts) if (!slist.find((s) => s.id === id)) { scene.remove(v.marker); v.label.remove(); sts.delete(id) }
      for (const st of slist) {
        let v = sts.get(st.id)
        if (!v) {
          const marker = new THREE.Mesh(new THREE.SphereGeometry(55, 14, 14), new THREE.MeshStandardMaterial({ color: 0x22c55e, metalness: 0.3, roughness: 0.4 }))
          scene.add(marker)
          v = { marker, label: label(st.name, st.color || '#22c55e', 'station') }
          sts.set(st.id, v)
        }
        v.st = st
        v.marker.material.color.set(st.color || '#22c55e')
        v.marker.position.copy(llScene(st.lat, st.lon, RE + 8))
        v.label.textContent = st.name
      }
    }
    sync()
    const offCatalog = onCatalog(sync)

    function rebuildRing(v, ms) {
      const s = v.sat, pts = [], a = RE + (s.a - RE) * ALT_VISUAL_MULT
      // one revolution of the osculating ellipse at `ms`, in the ECI frame
      const dt = (ms - s.epochMs) / 1000
      const O = s.raan0 + s.raanDot * dt, w = s.argp0 + s.argpDot * dt
      const cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(s.i), sI = Math.sin(s.i), cW = Math.cos(w), sW = Math.sin(w)
      for (let k = 0; k <= 180; k++) {
        const E = (k / 180) * TWO_PI
        const xp = a * (Math.cos(E) - s.e), yp = a * Math.sqrt(1 - s.e * s.e) * Math.sin(E)
        const x = (cO * cW - sO * sW * cI) * xp + (-cO * sW - sO * cW * cI) * yp
        const y = (sO * cW + cO * sW * cI) * xp + (-sO * sW + cO * cW * cI) * yp
        const z = sW * sI * xp + cW * sI * yp
        pts.push(new THREE.Vector3(x, z, -y))
      }
      v.ring.geometry.dispose()
      v.ring.geometry = new THREE.BufferGeometry().setFromPoints(pts)
      v.stamp = ms
    }

    // camera
    let rotX = 0.32, rotY = 0, dist = opts.distance, distGoal = dist, follow = null, lastT = performance.now()
    // rotate unit vector a toward b by fraction t (handles opposite vectors)
    const slerpDir = (a, b, t) => a.clone().applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a, b), t))
    let drag = null
    // camera flights: every mode change eases from the current pose into the new one
    const camTarget = new THREE.Vector3()
    let fly = null
    function flyFrom(ms) { fly = { pos: camera.position.clone(), up: camera.up.clone(), tgt: camTarget.clone(), t0: performance.now(), dur: ms * MOTION } }
    camera.position.set(0, Math.sin(rotX), Math.cos(rotX)).multiplyScalar(dist * 4.2)
    if (opts.intro) flyFrom(2200)
    // view handoff: start from the camera the previous Orbit view left, then fly to ours
    if (opts.handoff) {
      const h = takeHandoff()
      if (h) { camera.position.fromArray(h.pos); camera.up.fromArray(h.up); camTarget.fromArray(h.tgt); camera.lookAt(camTarget); flyFrom(3000) }
      handoffGlobe = () => ({ pos: camera.position.toArray(), up: camera.up.toArray(), tgt: camTarget.toArray() })
    }
    // chase camera: sits behind/above the satellite and looks at it
    let chase = null, chaseYaw = 0.5, chasePitch = 1.0, chaseDist = 1500, chaseDistGoal = 1500, chaseInfo = null
    const el = renderer.domElement
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId) })
    el.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (chase) {
        chaseYaw -= (e.clientX - drag.x) * 0.006
        chasePitch = Math.max(-0.2, Math.min(1.45, chasePitch + (e.clientY - drag.y) * 0.006))
        drag = { x: e.clientX, y: e.clientY }
        return
      }
      rotY += (e.clientX - drag.x) * 0.0045
      rotX = Math.max(-1.35, Math.min(1.35, rotX + (e.clientY - drag.y) * 0.0045))
      drag = { x: e.clientX, y: e.clientY }
      if (follow) follow = null
    })
    const end = () => { drag = null }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('wheel', (e) => { e.preventDefault(); if (chase) { chaseDistGoal = Math.max(350, Math.min(14000, chaseDistGoal * (e.deltaY > 0 ? 1.12 : 0.89))); return } distGoal = Math.max(opts.minDist, Math.min(opts.maxDist, distGoal * (e.deltaY > 0 ? 1.1 : 0.91))) }, { passive: false })

    function lookAtScene(v) { rotX = Math.asin(v.y / v.length()); rotY = Math.atan2(v.x, v.z) }

    let lastProj = 0
    function project(vec, el, show) {
      if (!labelsOn || !show) { el.style.display = 'none'; return }
      const v = vec.clone().project(camera)
      const w = container.clientWidth, h = container.clientHeight
      // hide labels behind the Earth
      const cam = camera.position, toObj = vec.clone().sub(cam), toCenter = cam.clone().negate()
      const along = toCenter.dot(toObj.clone().normalize())
      const closest = cam.clone().add(toObj.clone().normalize().multiplyScalar(along))
      const occluded = along > 0 && along < toObj.length() && closest.length() < RE
      el.style.display = v.z < 1 && !occluded ? 'block' : 'none'
      el.style.left = ((v.x * 0.5 + 0.5) * w) + 'px'
      el.style.top = ((-v.y * 0.5 + 0.5) * h) + 'px'
    }

    function update(ms, o) {
      o = o || {}
      const th = gmst(ms)
      updateSun(ms)
      if (!sunLabel) sunLabel = label('SUN', '#f59e0b', 'sun')
      clouds.rotation.y += 0.00008
      for (const [id, v] of sats) {
        const s = v.sat
        const show = !(o.hidden && o.hidden.includes(id)) && (!o.only || o.only.includes(id))
        v.group.visible = v.ring.visible = show
        if (!show) { v.link.visible = false; project(v.group.position, v.label, false); continue }
        if (Math.abs(ms - v.stamp) > 15 * 60000) rebuildRing(v, ms)
        v.ring.rotation.y = -th
        const p = ecefAt(s, ms)
        const disp = toScene(p, true)
        v.group.position.copy(disp)
        v.group.lookAt(0, 0, 0)
        const scale = id === o.focus ? 1.35 : 1
        v.group.scale.setScalar(scale)
        v.ring.material.opacity = !o.focus || id === o.focus ? 0.7 : 0.3
        let linked = false
        const stList = o.linkStations ? o.linkStations.map(stationById).filter(Boolean) : []
        for (const st of stList) {
          if (look(st, p).el >= (st.mask ?? 5)) {
            v.link.geometry.setFromPoints([llScene(st.lat, st.lon, RE + 8), disp])
            linked = true
            break
          }
        }
        v.link.visible = linked
        v.screen = disp
        if (chase === id) chaseInfo = { pos: disp.clone(), fwd: toScene(ecefAt(s, ms + 20000), true).sub(disp) }
        if (follow === id) {
          const tgt = disp.clone().normalize()
          const cur = new THREE.Vector3(Math.cos(rotX) * Math.sin(rotY), Math.sin(rotX), Math.cos(rotX) * Math.cos(rotY))
          cur.lerp(tgt, 0.08).normalize()
          lookAtScene(cur)
        }
      }
      for (const [id, v] of sts) {
        const show = !(o.hidden && o.hidden.includes(id))
        v.marker.visible = show
        v.marker.scale.setScalar(id === o.station ? 1.4 : 1)
        v.show = show
      }
      // wheel zoom eases toward its goal (time constant ~180 ms)
      const now = performance.now(), zk = MOTION ? 1 - Math.exp(-Math.min(100, now - lastT) / 180) : 1
      lastT = now
      dist = Math.exp(Math.log(dist) + (Math.log(distGoal) - Math.log(dist)) * zk)
      chaseDist = Math.exp(Math.log(chaseDist) + (Math.log(chaseDistGoal) - Math.log(chaseDist)) * zk)
      const pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tgt = new THREE.Vector3()
      if (chase && chaseInfo) {
        up.copy(chaseInfo.pos).normalize()
        const fwd = chaseInfo.fwd.clone().addScaledVector(up, -chaseInfo.fwd.dot(up)).normalize()
        const right = new THREE.Vector3().crossVectors(fwd, up)
        const back = fwd.clone().negate().multiplyScalar(Math.cos(chaseYaw)).addScaledVector(right, Math.sin(chaseYaw))
        const dir = back.multiplyScalar(Math.cos(chasePitch)).addScaledVector(up, Math.sin(chasePitch))
        pos.copy(chaseInfo.pos).addScaledVector(dir, chaseDist)
        // camera above and behind the satellite, looking down past it at the Earth
        tgt.copy(chaseInfo.pos).addScaledVector(up, -chaseDist * 0.12)
      } else {
        pos.set(dist * Math.cos(rotX) * Math.sin(rotY), dist * Math.sin(rotX), dist * Math.cos(rotX) * Math.cos(rotY))
      }
      if (fly) {
        // Position swings around the Earth (slerp of direction, log-lerp of range, gentle
        // pull-out mid-flight). The view direction and up are slerped on their own, so the
        // camera turns smoothly instead of chasing a look-at point that jumps between the
        // satellite and the Earth's centre. Smootherstep: zero speed and acceleration at both ends.
        const k = Math.min(1, (performance.now() - fly.t0) / Math.max(1, fly.dur)), e = k * k * k * (k * (6 * k - 15) + 10)
        const ra = fly.pos.length(), rb = pos.length()
        const om = fly.pos.angleTo(pos)
        const dir = slerpDir(fly.pos.clone().normalize(), pos.clone().normalize(), e)
        const fwdA = fly.tgt.clone().sub(fly.pos), fwdB = tgt.clone().sub(pos)
        const look = fwdA.length() + (fwdB.length() - fwdA.length()) * e
        const fwd = slerpDir(fwdA.normalize(), fwdB.normalize(), e)
        pos.copy(dir).multiplyScalar(Math.exp(Math.log(ra) + (Math.log(rb) - Math.log(ra)) * e) * (1 + 0.3 * Math.sin(Math.PI * e) * om / Math.PI))
        tgt.copy(pos).addScaledVector(fwd, look)
        up.copy(slerpDir(fly.up.clone().normalize(), up.clone().normalize(), e))
        if (k >= 1) fly = null
      }
      camera.up.copy(up)
      camera.position.copy(pos)
      camera.lookAt(tgt)
      camTarget.copy(tgt)
      if (trackLine) trackLine.rotation.y = 0
      renderer.render(scene, camera)
      if (now - lastProj > 33) {
        lastProj = now
        for (const [, v] of sats) project(v.group.position, v.label, v.group.visible)
        for (const [, v] of sts) project(v.marker.position, v.label, v.show)
        project(sunMark.position, sunLabel, sunOn)
      }
    }

    function setTrack(points) {
      if (trackLine) { scene.remove(trackLine); trackLine.geometry.dispose(); trackLine = null }
      if (!points || !points.length) return
      const pts = points.map((p) => llScene(p.lat, p.lon, RE + 12))
      trackLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.95 }))
      scene.add(trackLine)
    }

    return {
      update, sync, setTrack,
      setGrid(on) { grid.visible = on },
      setLabels(on) { labelsOn = on },
      setSun(on) { sunOn = on; sunStamp = -Infinity },
      lookFrom(v) { lookAtScene(v.clone ? v.clone() : new THREE.Vector3(v[0], v[1], v[2])); follow = null },
      rotate(dx, dy) { if (chase) { chaseYaw -= dx * 1.5; chasePitch = Math.max(-0.2, Math.min(1.45, chasePitch - dy * 1.5)); return } rotY += dx; rotX = Math.max(-1.35, Math.min(1.35, rotX + dy)); follow = null },
      reset() { dist = distGoal = opts.distance; rotX = 0.32; rotY = 0; follow = null; chase = null; chaseYaw = 0.5; chasePitch = 1.0; chaseDist = chaseDistGoal = 1500; flyFrom(2600) },
      setFollow(id) { follow = id; if (id) distGoal = Math.min(distGoal, 14500) },
      following() { return follow },
      setChase(id) { const fresh = id !== chase; chase = id; chaseInfo = null; if (id) follow = null; if (fresh) flyFrom(2800) },
      fly(ms) { flyFrom(ms ?? 1600) },
      // start far out along the current view direction and fly in
      arrive(ms, k) {
        const d = dist * (k ?? 4.2)
        camera.position.set(d * Math.cos(rotX) * Math.sin(rotY), d * Math.sin(rotX), d * Math.cos(rotX) * Math.cos(rotY))
        camera.up.set(0, 1, 0); camTarget.set(0, 0, 0); flyFrom(ms ?? 1800)
      },
      chasing() { return chase },
      focusStation(st) { lookAtScene(llScene(st.lat, st.lon, RE)); follow = null },
      setDistance(d) { dist = distGoal = d },
      dispose() { ro.disconnect(); offCatalog(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); labelsLayer.remove() },
    }
  }

  /* ─────────────────────────── small SVG charts ─────────────────────────── */

  function sparkline(svg, values, opts) {
    opts = Object.assign({ color: '#0284c7', w: 120, h: 46, pad: 3 }, opts)
    const finite = values.filter(Number.isFinite)
    if (finite.length < 2) { svg.innerHTML = '<text x="' + opts.w / 2 + '" y="' + opts.h / 2 + '" text-anchor="middle" font-size="7" fill="#94a3b8">no data</text>'; return }
    let min = Math.min(...finite, opts.floor ?? Infinity), max = Math.max(...finite, opts.ceil ?? -Infinity)
    if (min === max) { min -= 1; max += 1 }
    const n = values.length - 1
    const x = (k) => opts.pad + (k / n) * (opts.w - 2 * opts.pad)
    const y = (v) => opts.h - opts.pad - ((v - min) / (max - min)) * (opts.h - 2 * opts.pad)
    let d = '', open = false
    values.forEach((v, k) => { if (Number.isFinite(v)) { d += (open ? ' L' : ' M') + x(k).toFixed(1) + ',' + y(v).toFixed(1); open = true } else open = false })
    const gid = 'g' + Math.random().toString(36).slice(2, 7)
    let ref = ''
    if (opts.refLine != null && opts.refLine >= min && opts.refLine <= max) ref = '<line x1="0" x2="' + opts.w + '" y1="' + y(opts.refLine) + '" y2="' + y(opts.refLine) + '" stroke="#dc4747" stroke-width=".6" stroke-dasharray="2 2"/>'
    svg.setAttribute('viewBox', '0 0 ' + opts.w + ' ' + opts.h)
    svg.innerHTML = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + opts.color + '" stop-opacity=".28"/><stop offset="1" stop-color="' + opts.color + '" stop-opacity="0"/></linearGradient></defs>' +
      ref + '<path d="' + d + ' L' + x(n) + ',' + opts.h + ' L' + x(0) + ',' + opts.h + ' Z" fill="url(#' + gid + ')" opacity="' + (values.every(Number.isFinite) ? 1 : 0) + '"/>' +
      '<path d="' + d + '" fill="none" stroke="' + opts.color + '" stroke-width="1.6" stroke-linecap="round"/>'
  }

  function skyPlot(svg, track, opts) {
    opts = opts || {}
    const R = 46, c = 50
    const pt = (az, el) => { const r = R * (1 - Math.max(0, el) / 90), a = az * DEG; return [c + r * Math.sin(a), c - r * Math.cos(a)] }
    let g = '<circle cx="50" cy="50" r="46" fill="#0b1724" stroke="#2b4457" stroke-width=".6"/>'
    for (const el of [30, 60]) g += '<circle cx="50" cy="50" r="' + (R * (1 - el / 90)) + '" fill="none" stroke="#2b4457" stroke-width=".5" stroke-dasharray="1.5 1.5"/>'
    g += '<line x1="50" y1="4" x2="50" y2="96" stroke="#2b4457" stroke-width=".4"/><line x1="4" y1="50" x2="96" y2="50" stroke="#2b4457" stroke-width=".4"/>'
    g += '<text x="50" y="10" font-size="5" fill="#8ea3b5" text-anchor="middle">N</text><text x="92" y="52" font-size="5" fill="#8ea3b5" text-anchor="middle">E</text><text x="50" y="95" font-size="5" fill="#8ea3b5" text-anchor="middle">S</text><text x="8" y="52" font-size="5" fill="#8ea3b5" text-anchor="middle">W</text>'
    if (opts.mask) g += '<circle cx="50" cy="50" r="' + (R * (1 - opts.mask / 90)) + '" fill="none" stroke="#dc4747" stroke-width=".4" opacity=".7"/>'
    if (track && track.length > 1) {
      const d = track.map((p, k) => (k ? 'L' : 'M') + pt(p.az, p.el).map((v) => v.toFixed(1)).join(',')).join(' ')
      const a = pt(track[0].az, track[0].el), b = pt(track[track.length - 1].az, track[track.length - 1].el)
      g += '<path d="' + d + '" fill="none" stroke="#facc15" stroke-width="1.4"/>'
      g += '<circle cx="' + a[0] + '" cy="' + a[1] + '" r="1.8" fill="#22c55e"/><circle cx="' + b[0] + '" cy="' + b[1] + '" r="1.8" fill="#dc4747"/>'
    }
    if (opts.current && opts.current.el > 0) { const p = pt(opts.current.az, opts.current.el); g += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.6" fill="#38bdf8" stroke="#fff" stroke-width=".6"/>' }
    svg.setAttribute('viewBox', '0 0 100 100')
    svg.innerHTML = g
  }

  /* ─────────────────────────── space mode ─────────────────────────── */

  const MOTION = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1

  // The 3D canvas fills the page; shift the projection centre onto `frame`
  // (the viewport card, below its title bar) so the subject sits in the gap
  // between the panels; `dy` nudges it further down in px.
  function frameCamera(camera, container, frame, dy) {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight)
    if (frame) {
      const c = container.getBoundingClientRect(), f = frame.getBoundingClientRect()
      const title = frame.querySelector('.viewport-title'), top = f.top + (title ? title.offsetHeight : 0)
      camera.setViewOffset(w, h, w / 2 - (f.left + f.width / 2 - c.left), h / 2 - ((top + f.bottom) / 2 + (dy || 0) - c.top), w, h)
    }
    camera.updateProjectionMatrix()
  }

  // Scene transition: panels step aside, `steps` run as [fn, msUntilNext] while
  // only space is on screen, then the panels return.
  let stageId = 0
  function stage(steps, lead) {
    const id = ++stageId, b = document.body
    b.classList.add('ui-away')
    let t = (lead ?? 380) * MOTION
    for (const [fn, wait] of steps) { const at = t; setTimeout(() => { if (id === stageId) fn() }, at); t += wait * MOTION }
    setTimeout(() => { if (id === stageId) b.classList.remove('ui-away') }, t)
  }

  // Tab switches between Orbit views (Orbita.tsx swaps iframes): the outgoing
  // view hides its panels and leaves its camera pose in sessionStorage, the
  // incoming one starts from it, so the change reads as one camera move over
  // the same Earth (the scene clock is already shared).
  const HANDOFF_KEY = 'intisat-orbit-handoff'
  let handoffGlobe = null
  function takeHandoff() {
    try {
      const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null')
      sessionStorage.removeItem(HANDOFF_KEY)
      return h && Date.now() - h.at < 20000 ? h : null
    } catch { return null }
  }
  const toParent = (type) => { if (global.parent !== global) global.parent.postMessage({ type }, global.location.origin) }
  global.addEventListener('message', (e) => {
    if (e.source !== global.parent || e.origin !== global.location.origin || !e.data || e.data.type !== 'orbit-leave') return
    try {
      if (handoffGlobe) sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...handoffGlobe(), at: Date.now() }))
      else sessionStorage.removeItem(HANDOFF_KEY)
    } catch { /* no handoff, the next view just flies in */ }
    stageId++
    document.body.classList.add('ui-away')
    setTimeout(() => toParent('orbit-left'), 400 * MOTION)
  })

  /* ─────────────────────────── loop ─────────────────────────── */

  function loop(fn) {
    let last = performance.now(), frames = 0
    function frame(ts) {
      const dt = Math.min(ts - last, 100)
      last = ts
      fn(tick(dt), dt)
      // Earth drawn with its textures: the parent can drop the outgoing view
      if (frames >= 0 && texPending === 0 && ++frames === 3) { toParent('orbit-ready'); frames = -1 }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  global.Orbit = {
    DEG, RAD, RE, MU, VARIABLES, PALETTE,
    parseTLE, ecefAt, look, state, subPoint, gmst, sunEci, sunEcef, inEclipse, sunSync, SUN_RATE, predictPasses, passTrack, groundTrack, footprintKm, stationEcef,
    getCatalog, saveCatalog, onCatalog, satellites, validSatellites, stations, satById, stationById,
    activeSat, activeStation, setActiveSat, setActiveStation, isHidden, setHidden,
    addSatellite, updateSatelliteTLE, removeSatellite, addStation, updateStation, removeStation,
    clock, setTime, setSpeed, setPlaying, liveNow, onClock,
    compileExpr, createGlobe, sparkline, skyPlot, loop, MOTION, frameCamera, stage,
    mountHeader, updateHeaderClock, mountBridgeBadge, mountTimePanel,
    utcTime, utcHM, utcDate, utcStamp, dur, relTime, elClass, esc, epochAgeDays,
  }
})(window)
