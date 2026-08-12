/**
 * Input frame format.
 *
 * The sim only ever sees `InputFrame` objects. Everything upstream (keyboard,
 * gamepad, touch, AI, network) produces them, which is what makes rollback and
 * replays possible: a match is a seed plus two streams of these.
 *
 * Wire format is a fixed 8 bytes so an input packet for a dozen ticks still
 * fits comfortably inside one WebRTC datagram.
 */

export const BTN = {
  FIRE: 1 << 0,
  BOMB: 1 << 1,
  POD: 1 << 2,
  JUMP: 1 << 3,
  DASH: 1 << 4,
  LOCK: 1 << 5,
};

export function makeInput() {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
}

export function copyInput(dst, src) {
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
  return dst;
}

export function cloneInput(src) {
  return copyInput(makeInput(), src);
}

export const held = (inp, bit) => (inp.buttons & bit) !== 0;
export const pressed = (inp, prev, bit) =>
  (inp.buttons & bit) !== 0 && (prev.buttons & bit) === 0;
export const released = (inp, prev, bit) =>
  (inp.buttons & bit) === 0 && (prev.buttons & bit) !== 0;

const TAU = Math.PI * 2;
const q8 = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

/**
 * Quantise before the input reaches the sim — local and remote peers must feed
 * bit-identical values in, or determinism dies at the first analog stick.
 */
export function quantizeInput(inp) {
  inp.moveX = q8(inp.moveX) / 127;
  inp.moveZ = q8(inp.moveZ) / 127;
  let y = inp.yaw % TAU;
  if (y < 0) y += TAU;
  inp.yaw = (Math.round((y / TAU) * 65535) / 65535) * TAU;
  inp.pitch = Math.max(-32767, Math.min(32767, Math.round((inp.pitch / 1.6) * 32767))) / 32767 * 1.6;
  return inp;
}

export const INPUT_BYTES = 8;

export function writeInput(view, offset, inp) {
  view.setInt8(offset + 0, q8(inp.moveX));
  view.setInt8(offset + 1, q8(inp.moveZ));
  let y = inp.yaw % TAU;
  if (y < 0) y += TAU;
  view.setUint16(offset + 2, Math.round((y / TAU) * 65535), true);
  view.setInt16(offset + 4, Math.max(-32767, Math.min(32767, Math.round((inp.pitch / 1.6) * 32767))), true);
  view.setUint8(offset + 6, inp.buttons & 0xff);
  view.setUint8(offset + 7, 0);
}

export function readInput(view, offset, out = makeInput()) {
  out.moveX = view.getInt8(offset + 0) / 127;
  out.moveZ = view.getInt8(offset + 1) / 127;
  out.yaw = (view.getUint16(offset + 2, true) / 65535) * TAU;
  out.pitch = (view.getInt16(offset + 4, true) / 32767) * 1.6;
  out.buttons = view.getUint8(offset + 6);
  return out;
}
