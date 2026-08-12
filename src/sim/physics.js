/**
 * Collision for the sim layer.
 *
 * Bodies are vertical cylinders (`pos` is at the feet). Level geometry is a list
 * of yaw-rotated boxes plus the arena shell. Everything is resolved
 * analytically — no broadphase, because a holosseum tops out at a dozen boxes
 * and a flat scan beats a tree at that size.
 */

const EPS = 1e-4;

/** World -> box local space (yaw only). */
function toLocal(b, wx, wz, out) {
  const dx = wx - b.x;
  const dz = wz - b.z;
  out.x = b.cos * dx - b.sin * dz;
  out.z = b.sin * dx + b.cos * dz;
  return out;
}

/** Box local -> world direction. */
function toWorldDir(b, lx, lz, out) {
  out.x = b.cos * lx + b.sin * lz;
  out.z = -b.sin * lx + b.cos * lz;
  return out;
}

const _l = { x: 0, z: 0 };
const _w = { x: 0, z: 0 };

/** Horizontal distance from a point to a rotated box, plus the push-out normal. */
function horizPush(b, wx, wz, radius, out) {
  toLocal(b, wx, wz, _l);
  const cx = _l.x < -b.hx ? -b.hx : _l.x > b.hx ? b.hx : _l.x;
  const cz = _l.z < -b.hz ? -b.hz : _l.z > b.hz ? b.hz : _l.z;
  const dx = _l.x - cx;
  const dz = _l.z - cz;
  const d2 = dx * dx + dz * dz;

  if (d2 > EPS) {
    const d = Math.sqrt(d2);
    if (d >= radius) return false;
    toWorldDir(b, dx / d, dz / d, _w);
    out.nx = _w.x;
    out.nz = _w.z;
    out.depth = radius - d;
    return true;
  }

  // Centre is inside the footprint — escape along the shallowest face.
  const px = b.hx - Math.abs(_l.x);
  const pz = b.hz - Math.abs(_l.z);
  if (px < pz) {
    toWorldDir(b, Math.sign(_l.x) || 1, 0, _w);
    out.depth = px + radius;
  } else {
    toWorldDir(b, 0, Math.sign(_l.z) || 1, _w);
    out.depth = pz + radius;
  }
  out.nx = _w.x;
  out.nz = _w.z;
  return true;
}

/** True when the cylinder footprint overlaps the box footprint. */
function overlapsXZ(b, wx, wz, radius) {
  toLocal(b, wx, wz, _l);
  const cx = _l.x < -b.hx ? -b.hx : _l.x > b.hx ? b.hx : _l.x;
  const cz = _l.z < -b.hz ? -b.hz : _l.z > b.hz ? b.hz : _l.z;
  const dx = _l.x - cx;
  const dz = _l.z - cz;
  return dx * dx + dz * dz < radius * radius;
}

const _push = { nx: 0, nz: 0, depth: 0 };

/**
 * Integrate and resolve a cylinder body against the arena.
 *
 * `pos`/`vel` are mutated in place. Returns a shared result object — read it
 * before the next call.
 */
const _res = {
  grounded: false, groundY: 0, hitWall: false, hitCeiling: false,
  wallNx: 0, wallNz: 0, landedThisStep: false, impactSpeed: 0, groundKind: 'floor',
};

export function moveBody(arena, pos, vel, radius, height, dt) {
  const boxes = arena.boxes;
  const bounds = arena.bounds;

  _res.grounded = false;
  _res.hitWall = false;
  _res.hitCeiling = false;
  _res.landedThisStep = false;
  _res.wallNx = 0;
  _res.wallNz = 0;
  _res.impactSpeed = 0;
  _res.groundY = 0;
  _res.groundKind = 'floor';

  // ---- vertical ----------------------------------------------------------
  const prevFeet = pos.y;
  const prevHead = pos.y + height;
  let y = pos.y + vel.y * dt;

  if (vel.y <= 0) {
    let best = 0;
    let bestKind = 'floor';
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.top > prevFeet + EPS) continue;               // we were below its top
      if (b.top <= best) continue;                        // a higher surface already wins
      if (!overlapsXZ(b, pos.x, pos.z, radius)) continue;
      best = b.top;
      bestKind = b.kind;
    }
    if (y <= best) {
      _res.impactSpeed = -vel.y;
      y = best;
      vel.y = 0;
      _res.grounded = true;
      _res.groundY = best;
      _res.groundKind = bestKind;
      _res.landedThisStep = prevFeet > best + EPS;
    }
  } else {
    // Head bonk on a box underside or the arena ceiling.
    const head = y + height;
    let lowest = bounds.ceil;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.bottom < prevHead - EPS) continue;
      if (b.bottom >= lowest) continue;
      if (!overlapsXZ(b, pos.x, pos.z, radius)) continue;
      lowest = b.bottom;
    }
    if (head >= lowest) {
      y = lowest - height;
      vel.y = 0;
      _res.hitCeiling = true;
    }
  }
  pos.y = y;

  // ---- horizontal --------------------------------------------------------
  pos.x += vel.x * dt;
  pos.z += vel.z * dt;

  // Two relaxation passes keeps corners from squeezing the body through.
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      // Standing on top of it, or fully above/below it? Then no wall contact.
      if (pos.y >= b.top - EPS) continue;
      if (pos.y + height <= b.bottom + EPS) continue;
      if (!horizPush(b, pos.x, pos.z, radius, _push)) continue;

      pos.x += _push.nx * _push.depth;
      pos.z += _push.nz * _push.depth;

      // Kill the velocity component heading into the surface.
      const vn = vel.x * _push.nx + vel.z * _push.nz;
      if (vn < 0) {
        vel.x -= _push.nx * vn;
        vel.z -= _push.nz * vn;
      }
      _res.hitWall = true;
      _res.wallNx = _push.nx;
      _res.wallNz = _push.nz;
      moved = true;
    }
    if (!moved) break;
  }

  // ---- arena shell -------------------------------------------------------
  const lx = bounds.hx - radius;
  const lz = bounds.hz - radius;
  if (pos.x < -lx) { pos.x = -lx; if (vel.x < 0) vel.x = 0; _res.hitWall = true; _res.wallNx = 1; _res.wallNz = 0; }
  else if (pos.x > lx) { pos.x = lx; if (vel.x > 0) vel.x = 0; _res.hitWall = true; _res.wallNx = -1; _res.wallNz = 0; }
  if (pos.z < -lz) { pos.z = -lz; if (vel.z < 0) vel.z = 0; _res.hitWall = true; _res.wallNx = 0; _res.wallNz = 1; }
  else if (pos.z > lz) { pos.z = lz; if (vel.z > 0) vel.z = 0; _res.hitWall = true; _res.wallNx = 0; _res.wallNz = -1; }

  if (pos.y < 0) {
    _res.impactSpeed = -vel.y;
    _res.landedThisStep = prevFeet > EPS;
    pos.y = 0;
    vel.y = 0;
    _res.grounded = true;
    _res.groundY = 0;
    _res.groundKind = 'floor';
  }

  return _res;
}

// ---------------------------------------------------------------------------
// Projectile collision
// ---------------------------------------------------------------------------

const _hit = { hit: false, nx: 0, ny: 0, nz: 0, kind: '' };

/**
 * Point-vs-scene test for projectiles, with the surface normal so bullets can
 * spark, bombs can bounce, and decals can orient themselves.
 */
export function probePoint(arena, p, radius = 0) {
  _hit.hit = false;
  _hit.kind = '';

  const bounds = arena.bounds;
  if (p.y - radius <= 0) {
    _hit.hit = true; _hit.nx = 0; _hit.ny = 1; _hit.nz = 0; _hit.kind = 'floor';
    return _hit;
  }
  if (p.y + radius >= bounds.ceil) {
    _hit.hit = true; _hit.nx = 0; _hit.ny = -1; _hit.nz = 0; _hit.kind = 'ceiling';
    return _hit;
  }
  if (p.x - radius <= -bounds.hx) { _hit.hit = true; _hit.nx = 1; _hit.ny = 0; _hit.nz = 0; _hit.kind = 'wall'; return _hit; }
  if (p.x + radius >= bounds.hx) { _hit.hit = true; _hit.nx = -1; _hit.ny = 0; _hit.nz = 0; _hit.kind = 'wall'; return _hit; }
  if (p.z - radius <= -bounds.hz) { _hit.hit = true; _hit.nx = 0; _hit.ny = 0; _hit.nz = 1; _hit.kind = 'wall'; return _hit; }
  if (p.z + radius >= bounds.hz) { _hit.hit = true; _hit.nx = 0; _hit.ny = 0; _hit.nz = -1; _hit.kind = 'wall'; return _hit; }

  const boxes = arena.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (p.y - radius > b.top || p.y + radius < b.bottom) continue;
    toLocal(b, p.x, p.z, _l);
    if (Math.abs(_l.x) > b.hx + radius || Math.abs(_l.z) > b.hz + radius) continue;

    // Shallowest-axis normal, including the vertical faces.
    const px = b.hx + radius - Math.abs(_l.x);
    const pz = b.hz + radius - Math.abs(_l.z);
    const pyTop = b.top + radius - p.y;
    const pyBot = p.y - (b.bottom - radius);
    const py = Math.min(pyTop, pyBot);

    if (py <= px && py <= pz) {
      _hit.nx = 0; _hit.ny = pyTop < pyBot ? 1 : -1; _hit.nz = 0;
    } else if (px < pz) {
      toWorldDir(b, Math.sign(_l.x) || 1, 0, _w);
      _hit.nx = _w.x; _hit.ny = 0; _hit.nz = _w.z;
    } else {
      toWorldDir(b, 0, Math.sign(_l.z) || 1, _w);
      _hit.nx = _w.x; _hit.ny = 0; _hit.nz = _w.z;
    }
    _hit.hit = true;
    _hit.kind = b.kind;
    return _hit;
  }
  return _hit;
}

/** Height of the highest surface under a point — used by AI and pod pathing. */
export function groundHeightAt(arena, x, z, radius = 0.1) {
  let best = 0;
  const boxes = arena.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.top <= best) continue;
    if (!overlapsXZ(b, x, z, radius)) continue;
    best = b.top;
  }
  return best;
}

/**
 * Coarse line-of-sight check between two points. Samples along the segment —
 * cheap, deterministic, and accurate enough for a target the size of a robo.
 */
export function lineOfSight(arena, a, b, samples = 12) {
  const dx = (b.x - a.x) / samples;
  const dy = (b.y - a.y) / samples;
  const dz = (b.z - a.z) / samples;
  const p = { x: a.x, y: a.y, z: a.z };
  for (let i = 1; i < samples; i++) {
    p.x += dx; p.y += dy; p.z += dz;
    const boxes = arena.boxes;
    for (let j = 0; j < boxes.length; j++) {
      const bx = boxes[j];
      if (p.y > bx.top || p.y < bx.bottom) continue;
      toLocal(bx, p.x, p.z, _l);
      if (Math.abs(_l.x) <= bx.hx && Math.abs(_l.z) <= bx.hz) return false;
    }
  }
  return true;
}
