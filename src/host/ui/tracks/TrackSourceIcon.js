const ICON_MAP = {
  plus: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 5.4v9.2M5.4 10h9.2" />
    </svg>
  `,
  piano: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2" />
      <path d="M7 4.2v7.2M10 4.2v7.2M13 4.2v7.2M5.2 11.4h9.6" />
    </svg>
  `,
  violin: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <g transform="rotate(15 10 10)">
        <path d="M10 4C7 4 6 7 8 9v2c-3 2-3 7 2 7s5-5 2-7V9c2-2 1-5-2-5Z" />
        <line x1="10" y1="4" x2="10" y2="1.1" />
      </g>
      <line x1="3" y1="17" x2="17" y2="3" />
    </svg>
  `,
  drums: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <ellipse cx="10" cy="9.2" rx="5.8" ry="2.6" />
      <path d="M4.2 9.2v4.2c0 1.4 2.6 2.6 5.8 2.6s5.8-1.2 5.8-2.6V9.2" />
      <path d="M6 5.2l3 2M14 5.2l-3 2" />
    </svg>
  `,
  audio: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.6 11.6V8.4c0-.7.6-1.2 1.2-1.2h2.4l3.2-2.6v10.8l-3.2-2.6H5.8c-.6 0-1.2-.5-1.2-1.2Z" />
      <path d="M13.4 7.2a3.3 3.3 0 0 1 0 5.6M15.6 5.2a5.8 5.8 0 0 1 0 9.6" />
    </svg>
  `,
  vocal: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7.2" y="3.4" width="5.6" height="8.6" rx="2.8" />
      <path d="M5.4 9.8a4.6 4.6 0 0 0 9.2 0M10 14.4v2.4M7.4 16.8h5.2" />
    </svg>
  `,
}

export function createTrackSourceIcon(sourceId, label) {
  const icon = document.createElement('span')
  const iconKey = sourceId || 'plus'
  icon.className = `track-source-icon source-${iconKey}`
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = ICON_MAP[iconKey] || ICON_MAP.plus
  if (label) icon.dataset.label = label
  return icon
}
