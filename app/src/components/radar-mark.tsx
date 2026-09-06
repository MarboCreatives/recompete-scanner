// The Recompete Radar mark, inline.
//
// It is the same artwork as brand/a2.svg, the radar scope used as the profile
// picture on X and LinkedIn, redrawn here at a smaller viewBox and stripped of
// its background plate so it sits on the page rather than in a box. Inline
// rather than an <img> because it is 700 bytes, and a file would be one more
// request on a page that can carry a sign-in token in its address.
//
// aria-hidden because the wordmark beside it already says the name; a screen
// reader announcing it twice is worse than not announcing it at all.

export function RadarMark() {
  return (
    <svg viewBox="0 0 100 100" role="presentation" aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="49" fill="#121926" />
      <g fill="none" stroke="#2f3f54" strokeWidth="1.6">
        <circle cx="50" cy="50" r="16" />
        <circle cx="50" cy="50" r="29" />
        <circle cx="50" cy="50" r="42" />
      </g>
      <path d="M50 50 L50 8 A42 42 0 0 1 79.7 20.3 Z" fill="#4da3ff" opacity="0.22" />
      <line
        x1="50"
        y1="50"
        x2="79.7"
        y2="20.3"
        stroke="#4da3ff"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="70.5" cy="29.5" r="11.2" fill="#ffb454" opacity="0.2" />
      <circle cx="70.5" cy="29.5" r="5.6" fill="#ffb454" />
      <circle cx="50" cy="50" r="2.6" fill="#e6e9ef" />
    </svg>
  )
}
