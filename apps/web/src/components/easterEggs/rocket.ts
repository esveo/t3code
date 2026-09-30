const FLIGHT_MS = 2400;
const SVG_NS = "http://www.w3.org/2000/svg";

const ROCKET_SVG = `
<svg xmlns="${SVG_NS}" viewBox="0 0 64 150" width="64" height="150" aria-hidden="true">
  <defs>
    <linearGradient id="esveo-rocket-body" x1="0" x2="1">
      <stop offset="0" stop-color="#cbd5e1" />
      <stop offset="0.45" stop-color="#ffffff" />
      <stop offset="1" stop-color="#94a3b8" />
    </linearGradient>
    <linearGradient id="esveo-rocket-flame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fef08a" />
      <stop offset="0.35" stop-color="#fb923c" />
      <stop offset="1" stop-color="#ef4444" stop-opacity="0" />
    </linearGradient>
  </defs>
  <g class="esveo-rocket-flame" style="transform-origin: 32px 94px">
    <path d="M22 94 C 22 112 28 128 32 146 C 36 128 42 112 42 94 Z" fill="url(#esveo-rocket-flame)" />
    <path d="M27 94 C 27 106 30 116 32 126 C 34 116 37 106 37 94 Z" fill="#fffbeb" />
  </g>
  <path d="M16 62 L3 94 L17 88 Z" fill="#dc2626" />
  <path d="M48 62 L61 94 L47 88 Z" fill="#dc2626" />
  <rect x="22" y="86" width="20" height="9" rx="2" fill="#475569" />
  <path d="M32 4 C 48 20 51 50 48 88 L 16 88 C 13 50 16 20 32 4 Z" fill="url(#esveo-rocket-body)" stroke="#334155" stroke-width="1.5" />
  <path d="M32 4 C 40 12 44 20 46 28 L 18 28 C 20 20 24 12 32 4 Z" fill="#dc2626" />
  <circle cx="32" cy="44" r="8" fill="#38bdf8" stroke="#334155" stroke-width="3" />
  <circle cx="29" cy="41" r="2.5" fill="#e0f2fe" />
  <text x="32" y="72" text-anchor="middle" font-family="system-ui, sans-serif" font-size="9" font-weight="700" fill="#334155">esveo</text>
</svg>`;

/**
 * Fork: flies a rocket from the bottom of the window up past its top, then
 * removes every trace of it. Runs once; nothing repaints after it lands.
 */
export function launchRocket() {
  const stage = document.createElement("div");
  stage.style.cssText =
    "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483647";

  const x = window.innerWidth * (0.3 + Math.random() * 0.4);
  const rocket = document.createElement("div");
  rocket.style.cssText = `position:absolute;left:${x - 32}px;top:100%;will-change:transform`;
  rocket.innerHTML = ROCKET_SVG;
  stage.append(rocket);

  for (let index = 0; index < 10; index++) stage.append(smokePuff(x, index));
  document.body.append(stage);

  const drift = (Math.random() - 0.5) * 120;
  const travel = window.innerHeight + 200;
  const flight = rocket.animate(
    [
      { transform: "translate(0, 0) rotate(0deg)", easing: "ease-out" },
      { transform: "translate(0, -170px) rotate(-2deg)", offset: 0.18, easing: "ease-in-out" },
      { transform: "translate(2px, -190px) rotate(2deg)", offset: 0.28, easing: "ease-in" },
      { transform: `translate(${drift}px, -${travel + 170}px) rotate(${drift / 20}deg)` },
    ],
    { duration: FLIGHT_MS, fill: "forwards" },
  );
  rocket
    .querySelector(".esveo-rocket-flame")
    ?.animate([{ transform: "scaleY(0.85)" }, { transform: "scaleY(1.25)" }], {
      duration: 90,
      iterations: Math.ceil(FLIGHT_MS / 90),
      direction: "alternate",
    });

  const land = () => stage.remove();
  flight.finished.then(land, land);
}

function smokePuff(x: number, index: number) {
  const puff = document.createElement("div");
  const size = 40 + Math.random() * 40;
  puff.style.cssText = `position:absolute;left:${x - size / 2}px;top:calc(100% - ${size / 2}px);width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle, rgba(226,232,240,0.9), rgba(148,163,184,0) 70%);will-change:transform,opacity`;
  const side = index % 2 === 0 ? 1 : -1;
  const spread = side * (20 + Math.random() * 120);
  puff.animate(
    [
      { transform: "translate(0, 0) scale(0.3)", opacity: 0 },
      { transform: `translate(${spread * 0.4}px, -20px) scale(1)`, opacity: 0.9, offset: 0.2 },
      { transform: `translate(${spread}px, -${30 + Math.random() * 50}px) scale(2.2)`, opacity: 0 },
    ],
    {
      duration: 1400 + Math.random() * 600,
      delay: 150 + index * 40,
      fill: "both",
      easing: "ease-out",
    },
  );
  return puff;
}
