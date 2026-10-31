export interface NavTab {
  label: string
  path: string
}

export interface NavSection {
  id: string
  label: string
  path: string
  icon: string
  tabs: NavTab[]
  adminOnly?: boolean
}

const ICONS = {
  dashboard: 'M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6ZM13 9h8V3h-8v6Z',
  orbit: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9m0-18c-2.5 2.5-3.8 5.6-3.8 9s1.3 6.5 3.8 9M3.5 9h17M3.5 15h17',
  logs: 'M4 4h16v4H4V4Zm0 6h16v10H4V10Zm3 3h6M7 16h10',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.15-1.55l2.1-1.63-2-3.46-2.48 1a8 8 0 0 0-2.68-1.55L14.4 2h-4.8l-.4 2.81a8 8 0 0 0-2.68 1.55l-2.48-1-2 3.46 2.1 1.63a8 8 0 0 0 0 3.1L1.94 15.18l2 3.46 2.48-1a8 8 0 0 0 2.68 1.55l.4 2.81h4.8l.4-2.81a8 8 0 0 0 2.68-1.55l2.48 1 2-3.46-2.1-1.63A8 8 0 0 0 20 12Z',
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard/general',
    icon: ICONS.dashboard,
    tabs: [
      { label: 'General', path: '/dashboard/general' },
      { label: 'EPS / Thermal', path: '/dashboard/eps' },
      { label: 'ADCS', path: '/dashboard/adcs' },
      { label: 'Communications', path: '/dashboard/comms' },
      { label: 'Payload', path: '/dashboard/payload' },
    ],
  },
  {
    id: 'orbita',
    label: 'Orbit',
    path: '/orbita/general',
    icon: ICONS.orbit,
    tabs: [
      { label: 'General', path: '/orbita/general' },
      { label: 'Passes', path: '/orbita/passes' },
      { label: 'Sun-Sync', path: '/orbita/sunsync' },
      { label: 'Calendar', path: '/orbita/calendar' },
      { label: 'Free View', path: '/orbita/free' },
    ],
  },
  {
    id: 'logs',
    label: 'Logs',
    path: '/logs/mensajes',
    icon: ICONS.logs,
    tabs: [
      { label: 'Messages', path: '/logs/mensajes' },
      { label: 'Decoded Variables', path: '/logs/variables' },
    ],
  },
  {
    id: 'configuracion',
    label: 'Settings',
    path: '/configuracion/sdr',
    icon: ICONS.settings,
    adminOnly: true,
    tabs: [
      { label: 'SDR & Reception', path: '/configuracion/sdr' },
      { label: 'Scheduling', path: '/configuracion/programacion' },
      { label: 'SDR Diagnostics', path: '/configuracion/diagnostico' },
    ],
  },
]

export function sectionForPath(pathname: string): NavSection | undefined {
  return NAV_SECTIONS.find((s) => pathname.startsWith(`/${s.id}`))
}
