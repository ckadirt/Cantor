/**
 * How Cantor works, as a scene that plays: phones, the relay and computers,
 * each where the current scene seats it, and on every connection the same
 * round trip on its own clock. The phone asks; the ask is sealed and crosses
 * the relay, which sees only bytes; the computer makes the song, its fan
 * turning and the song's shape drawing on its screen; the song comes back
 * sealed; the phone plays it.
 *
 * The scroll picks the scene (`privacy-stage.ts`); everything else is time.
 */
import { FACE_MAX_EXTENT, facePoints } from '../../../cantor/src/lenses/face';
import { recipeOf } from '../lib/art';

export type Scene = 'how' | 'share' | 'network';
type Kind = 'phone' | 'laptop' | 'desktop' | 'server' | 'cloud';
type Link = [from: string, to: string, scenes: Scene[]];

/** One round trip, in ms: ask, there, make, back, play. */
const TRIP = { ASK: 1300, THERE: 1500, MAKE: 1900, BACK: 1500, PLAY: 2300, REST: 600 } as const;
const TRIP_MS = Object.values(TRIP).reduce((a, b) => a + b, 0);
/** Connections after the first start apart, so the network never moves in step. */
const STAGGER_MS = 1700;

/** Where a screen sits in each drawing, as fractions of its box: centre x, centre y, radius over width. */
const SCREENS: Partial<Record<Kind, [number, number, number]>> = {
  phone: [0.5, 0.49, 0.24],
  laptop: [0.5, 0.43, 0.17],
  desktop: [0.346, 0.3625, 0.15],
};

const ASKS = ['a slow blues, at dusk', 'rain on a tin roof', 'a waltz for two', 'cumbia under the bridge', 'first light', 'a lullaby in D'];
const HEX = '0123456789abcdef';
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function startNetworkStage(figure: HTMLElement) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = figure.querySelector<HTMLCanvasElement>('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const ends = new Map(
    [...figure.querySelectorAll<HTMLElement>('[data-end]')].map((el) => [
      el.dataset.end!,
      { el, kind: el.dataset.kind as Kind, at: JSON.parse(el.dataset.at!) as Partial<Record<Scene, [number, number]>> },
    ]),
  );
  const links = (JSON.parse(figure.dataset.links!) as Link[]).map((link, k) => ({ link, k, since: -1 }));
  let scene: Scene | null = null;
  /** Each computer's fan: how fast it turns (eased toward busy or still) and where it stands. */
  const fans = new Map<string, { rotor: SVGGElement; speed: number; angle: number }>();
  for (const [key, end] of ends) {
    const rotor = end.el.querySelector<SVGGElement>('.rotor');
    if (rotor) fans.set(key, { rotor, speed: 0, angle: 0 });
  }
  let lastNow = performance.now();

  const seat = (next: Scene | null) => {
    if (next === scene) return;
    scene = next;
    figure.dataset.scene = next ?? '';
    for (const end of ends.values()) {
      const place = next ? end.at[next] : undefined;
      end.el.classList.toggle('on', place !== undefined);
      if (place) {
        end.el.style.left = `${place[0]}%`;
        end.el.style.top = `${place[1]}%`;
      }
    }
  };

  /** Called each frame with the scene the scroll is in, or null when the wire is not showing. */
  const update = (next: Scene | null, now: number) => {
    seat(next);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    if (!scene) {
      for (const l of links) l.since = -1;
      return;
    }
    const st = getComputedStyle(figure);
    const ink = st.getPropertyValue('--ink').trim();
    const paper = st.getPropertyValue('--paper').trim();
    const muted = st.getPropertyValue('--muted').trim();
    const box = canvas.getBoundingClientRect();
    const place = (key: string) => {
      const b = ends.get(key)!.el.querySelector('svg')!.getBoundingClientRect();
      return { x: (b.left - box.left) * dpr, y: (b.top - box.top) * dpr, w: b.width * dpr, h: b.height * dpr };
    };
    const centre = (r: ReturnType<typeof place>) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const relay = place('relay');
    const rc = centre(relay);
    const busy = new Set<string>();
    const playing = new Set<string>();

    const live = links.filter(({ link }) => link[2].includes(scene!));
    for (const l of links) if (!live.includes(l)) l.since = -1;
    live.forEach((l, lane) => {
      const [from, to] = l.link;
      if (l.since < 0) l.since = now;
      const shown = still ? 1 : clamp((now - l.since) / 500);
      const a = place(from);
      const b = place(to);
      const ac = centre(a);
      const bc = centre(b);
      // Phone to the relay, through it in a lane of its own, and on to the computer.
      const ly = rc.y + relay.h * 0.12 + (lane - (live.length - 1) / 2) * 7 * dpr;
      const pad = 12 * dpr;
      const side = (c: { x: number }, r: { w: number }, toward: number) => c.x + Math.sign(toward - c.x) * (r.w / 2 + pad);
      const p0 = { x: side(ac, a, rc.x), y: ac.y };
      const r0 = { x: rc.x - relay.w * 0.43, y: ly };
      const r1 = { x: rc.x + relay.w * 0.43, y: ly };
      const p1 = { x: side(bc, b, rc.x), y: bc.y };
      const path = [...curve(p0, r0), ...curve(r1, p1)];
      const inRelay = (q: { x: number }) => q.x > r0.x + 1 && q.x < r1.x - 1;
      /** How far into the relay a point is, 0 at its edge to 1 a little inside: where a message turns to bytes. */
      const sealing = (q: { x: number }) => clamp(Math.min(q.x - r0.x, r1.x - q.x) / (16 * dpr));
      const along = measure(path);

      ctx.globalAlpha = shown;
      ctx.strokeStyle = muted;
      ctx.lineWidth = dpr;
      ctx.setLineDash([2 * dpr, 4 * dpr]);
      // The line itself drifts, phone to computer, so a quiet connection still reads as live.
      ctx.lineDashOffset = still ? 0 : -((now / 45) % (6 * dpr));
      ctx.beginPath();
      path.forEach((q, i) => (i && !inRelay(q) && !inRelay(path[i - 1]) ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // The round trip, on this connection's own clock.
      const delay = l.k === 0 ? 300 : 400 + lane * STAGGER_MS * 0.6;
      const t = still ? TRIP.ASK + TRIP.THERE + TRIP.MAKE * 0.6 : now - l.since - delay;
      if (t < 0) return;
      const round = Math.floor(t / TRIP_MS);
      let u = t % TRIP_MS;
      const ask = ASKS[(l.k + round) % ASKS.length];
      const song = recipeOf(`${from} ${to} ${round}`);

      if (u < TRIP.ASK) {
        // The ask, written on the phone, then folded into a sealed message.
        const typed = clamp(u / (TRIP.ASK * 0.6));
        const fold = smoother(clamp((u - TRIP.ASK * 0.7) / (TRIP.ASK * 0.3)));
        if (l.k === 0 && scene === 'how') {
          ctx.globalAlpha = shown * (1 - fold);
          ctx.fillStyle = ink;
          ctx.font = `italic ${16 * dpr}px "CMU Serif", Georgia, serif`;
          ctx.textAlign = 'left';
          ctx.fillText(`“${ask.slice(0, Math.round(typed * ask.length))}”`, p0.x, ac.y - 18 * dpr);
        }
        if (fold > 0) envelope(lerpPt(ac, p0, fold), fold, ink, paper, dpr, shown);
        return;
      }
      u -= TRIP.ASK;
      if (u < TRIP.THERE) {
        // It shrinks into the computer as it arrives.
        const f = u / TRIP.THERE;
        packet(along, smoother(f), sealing, ink, paper, dpr, shown * (1 - clamp((f - 0.9) / 0.1)), l.k, 1 - 0.6 * clamp((f - 0.82) / 0.18));
        return;
      }
      u -= TRIP.THERE;
      if (u < TRIP.MAKE) {
        // The computer makes it: its fan turns, the song's shape draws on its screen.
        busy.add(to);
        const f = u / TRIP.MAKE;
        // Drawn, held a moment, then folded small to be sealed and sent back.
        const fold = smoother(clamp((f - 0.85) / 0.15));
        drawOnScreen(ends.get(to)!.kind, b, song, smoother(clamp(f / 0.7)), false, ink, dpr, shown * (1 - fold * 0.8), 1 - fold * 0.7);
        return;
      }
      u -= TRIP.MAKE;
      if (u < TRIP.BACK) {
        const f = u / TRIP.BACK;
        packet(along, 1 - smoother(f), sealing, ink, paper, dpr, shown * clamp(f / 0.1), l.k + 7, 0.4 + 0.6 * clamp(f / 0.18));
        return;
      }
      u -= TRIP.BACK;
      if (u < TRIP.PLAY) {
        // The phone plays it: the song on its screen, sound leaving it.
        playing.add(from);
        // The song opens out of the message onto the screen, plays, and fades.
        const open = smoother(clamp(u / 350));
        const end = 1 - clamp((u - (TRIP.PLAY - 500)) / 500);
        drawOnScreen('phone', a, song, 1, true, ink, dpr, shown * end, 0.3 + 0.7 * open);
        for (let k = 0; k < 3; k += 1) {
          const wave = ((u / 900 + k / 3) % 1);
          ctx.globalAlpha = shown * (1 - wave) * 0.8 * open * end;
          ctx.strokeStyle = ink;
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.arc(ac.x, ac.y, a.h * 0.55 + wave * 22 * dpr, -0.45, 0.45);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ac.x, ac.y, a.h * 0.55 + wave * 22 * dpr, Math.PI - 0.45, Math.PI + 0.45);
          ctx.stroke();
        }
      }
    });
    ctx.globalAlpha = 1;
    for (const [key, end] of ends) {
      end.el.classList.toggle('busy', busy.has(key));
      end.el.classList.toggle('playing', playing.has(key));
    }
    // Fans spin up when a song starts and wind down after, never on or off at once.
    const dt = Math.min(64, now - lastNow);
    lastNow = now;
    for (const [key, fan] of fans) {
      fan.speed += ((busy.has(key) && !still ? 1 : 0) - fan.speed) * Math.min(1, dt / 350);
      fan.angle = (fan.angle + fan.speed * dt * 0.55) % 360;
      fan.rotor.style.transform = `rotate(${fan.angle}deg)`;
    }
  };

  function packet(along: (u: number) => { x: number; y: number }, u: number, sealing: (q: { x: number }) => number, ink: string, paper: string, dpr: number, alpha: number, seed: number, size = 1) {
    const q = along(u);
    // Inside the relay a message is all the relay has: bytes it cannot open.
    // At its edge the envelope gives way to them, and back.
    const bytes = sealing(q);
    if (bytes > 0) {
      ctx.globalAlpha = alpha * bytes;
      ctx.fillStyle = ink;
      ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(HEX[(seed * 5 + Math.floor(q.x / 9)) % 16] + HEX[(seed * 11 + Math.floor(q.x / 13)) % 16] + HEX[(seed * 3 + 7) % 16], q.x, q.y + 3 * dpr);
    }
    if (bytes < 1) envelope(q, size * (1 - bytes * 0.5), ink, paper, dpr, alpha * (1 - bytes));
  }

  /** A sealed message: a small envelope, closed. */
  function envelope(q: { x: number; y: number }, size: number, ink: string, paper: string, dpr: number, alpha: number) {
    const ew = 16 * dpr * size;
    const eh = 11 * dpr * size;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = paper;
    ctx.strokeStyle = ink;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.rect(q.x - ew / 2, q.y - eh / 2, ew, eh);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(q.x - ew / 2, q.y - eh / 2);
    ctx.lineTo(q.x, q.y + eh * 0.1);
    ctx.lineTo(q.x + ew / 2, q.y - eh / 2);
    ctx.stroke();
  }

  /** A song's shape on a device's screen; for a server, above it. */
  function drawOnScreen(kind: Kind, r: { x: number; y: number; w: number; h: number }, recipe: ReturnType<typeof recipeOf>, drawn: number, filled: boolean, ink: string, dpr: number, alpha: number, scale = 1) {
    const screen = SCREENS[kind] ?? [0.5, -0.3, 0.14];
    const cx = r.x + r.w * screen[0];
    const cy = r.y + r.h * screen[1];
    const rad = r.w * screen[2] * scale;
    const pts = facePoints(recipe, 72);
    const n = Math.max(2, Math.floor(drawn * pts.length));
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const x = cx + (pts[i].x / FACE_MAX_EXTENT) * rad;
      const y = cy + (pts[i].y / FACE_MAX_EXTENT) * rad;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    if (drawn >= 1) ctx.closePath();
    if (filled) ctx.fill();
    ctx.stroke();
  }

  return { update };
}

/** A soft curve from one point to another, leaving and arriving level. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const k = (b.x - a.x) * 0.5;
  const out = [];
  for (let i = 0; i <= 32; i += 1) {
    const t = i / 32;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * (a.x + k) + 3 * u * t * t * (b.x - k) + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y,
    });
  }
  return out;
}

/** A point `u` of the way along a polyline, by length. */
function measure(pts: { x: number; y: number }[]) {
  const lens = [0];
  for (let i = 1; i < pts.length; i += 1) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lens[lens.length - 1];
  return (u: number) => {
    const d = u * total;
    let i = 1;
    while (i < lens.length - 1 && lens[i] < d) i += 1;
    const t = (d - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
}

const lerpPt = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
