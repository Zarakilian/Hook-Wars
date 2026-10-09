// The frame format the desktop relays send over Steam P2P (reliable, ordered packets).
//
//   byte 0-1  magic 'H' 'W'
//   byte 2    format version (1)
//   byte 3    low 4 bits: frame type; bit 7: the payload is the next piece of this connection's
//             deflate stream (./streamCodec.ts; Data frames from the host only)
//   byte 4-5  connection id, uint16 big-endian (0 for Ping, Pong and Bye; 1..65535 otherwise)
//   byte 6-9  payload length, uint32 big-endian; must equal the bytes that follow
//
// Open   joiner -> host: "open a connection to the game server for me". host -> joiner: "it is open".
// Data   one WebSocket text message (UTF-8). Host -> joiner it is deflated with the connection's
//        stream, and the joiner caps the inflated size.
// Close  uint16 close code + UTF-8 reason (at most 123 bytes, the WebSocket limit).
// Ping   8 bytes, answered by a Pong with the same 8 bytes.
// Bye    UTF-8 reason: the sender is leaving (the host left, or a joiner left the lobby).
//
// Anything that does not match exactly is malformed: the receiver drops the sender.
import { MAX_CLIENT_MESSAGE } from './constants.ts';

export const FrameType = { Open: 1, Data: 2, Close: 3, Ping: 4, Pong: 5, Bye: 6 } as const;
export type FrameTypeId = (typeof FrameType)[keyof typeof FrameType];

export const MAGIC_0 = 0x48; // 'H'
export const MAGIC_1 = 0x57; // 'W'
export const FRAME_VERSION = 1;
export const HEADER_BYTES = 10;
export const FLAG_DEFLATE = 0x80;
const TYPE_MASK = 0x0f;
const MAX_REASON_BYTES = 123;
const PING_BYTES = 8;

export interface Frame {
  type: FrameTypeId;
  conn: number;
  deflated: boolean;
  payload: Buffer;
}

export interface FrameLimits {
  /** largest packet accepted, header included */
  maxPacket: number;
  /** whether Data frames may be deflated (stream-compressed) */
  allowDeflate: boolean;
  /** largest message after inflating */
  maxMessage: number;
}

/** What a joiner may send the host: one client message per Data frame, never compressed. */
export const JOINER_TO_HOST: FrameLimits = { maxPacket: HEADER_BYTES + MAX_CLIENT_MESSAGE, allowDeflate: false, maxMessage: MAX_CLIENT_MESSAGE };
/** What the host may send a joiner: server messages (snapshots about 12 KB raw), stream-deflated. */
export const HOST_TO_JOINER: FrameLimits = { maxPacket: 256 * 1024, allowDeflate: true, maxMessage: 1024 * 1024 };

export type DecodeResult = { ok: true; frame: Frame } | { ok: false; reason: string };

export function encodeFrame(type: FrameTypeId, conn: number, payload: Uint8Array = Buffer.alloc(0), deflated = false): Buffer {
  if (!Number.isInteger(conn) || conn < 0 || conn > 0xffff) throw new RangeError('connection id out of range');
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = FRAME_VERSION;
  out[3] = type | (deflated ? FLAG_DEFLATE : 0);
  out.writeUInt16BE(conn, 4);
  out.writeUInt32BE(payload.length, 6);
  out.set(payload, HEADER_BYTES);
  return out;
}

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));
const CONN_FRAMES = new Set<number>([FrameType.Open, FrameType.Data, FrameType.Close]);

/** Parse and check one packet. Never throws. */
export function decodeFrame(packet: Uint8Array, limits: FrameLimits): DecodeResult {
  if (packet.length < HEADER_BYTES) return { ok: false, reason: 'short packet' };
  if (packet.length > limits.maxPacket) return { ok: false, reason: 'oversized packet' };
  if (packet[0] !== MAGIC_0 || packet[1] !== MAGIC_1) return { ok: false, reason: 'bad magic' };
  if (packet[2] !== FRAME_VERSION) return { ok: false, reason: 'unknown version' };
  const b3 = packet[3];
  const type = b3 & TYPE_MASK;
  const flags = b3 & ~TYPE_MASK;
  if (!KNOWN_TYPES.has(type)) return { ok: false, reason: 'unknown type' };
  if (flags & ~FLAG_DEFLATE) return { ok: false, reason: 'unknown flags' };
  const deflated = (flags & FLAG_DEFLATE) !== 0;
  if (deflated && (type !== FrameType.Data || !limits.allowDeflate)) return { ok: false, reason: 'unexpected compression' };
  const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  const conn = buf.readUInt16BE(4);
  const len = buf.readUInt32BE(6);
  if (len !== packet.length - HEADER_BYTES) return { ok: false, reason: 'length mismatch' };
  if (CONN_FRAMES.has(type) ? conn === 0 : conn !== 0) return { ok: false, reason: 'bad connection id' };
  const payload = buf.subarray(HEADER_BYTES);
  switch (type) {
    case FrameType.Open:
      if (len !== 0) return { ok: false, reason: 'open with payload' };
      break;
    case FrameType.Close:
      if (len < 2 || len > 2 + MAX_REASON_BYTES) return { ok: false, reason: 'bad close' };
      break;
    case FrameType.Ping:
    case FrameType.Pong:
      if (len !== PING_BYTES) return { ok: false, reason: 'bad ping' };
      break;
    case FrameType.Bye:
      if (len > MAX_REASON_BYTES) return { ok: false, reason: 'bad bye' };
      break;
    case FrameType.Data:
      if (!deflated && len > limits.maxMessage) return { ok: false, reason: 'oversized message' };
      break;
    default:
      break;
  }
  return { ok: true, frame: { type: type as FrameTypeId, conn, deflated, payload } };
}

/** A Data frame carrying one WebSocket text message as it is (its UTF-8 bytes). */
export function encodeData(conn: number, message: Uint8Array): Buffer {
  return encodeFrame(FrameType.Data, conn, message);
}

/** A Data frame carrying one message's piece of the connection's deflate stream. */
export function encodeDeflatedData(conn: number, piece: Uint8Array): Buffer {
  return encodeFrame(FrameType.Data, conn, piece, true);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 bytes as text, or null if they are not valid UTF-8 or longer than max. */
export function utf8Text(bytes: Uint8Array, max: number): string | null {
  if (bytes.length > max) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The text of an uncompressed Data frame, or null (compressed, too big or not UTF-8). */
export function dataText(frame: Frame, limits: FrameLimits): string | null {
  return frame.deflated ? null : utf8Text(frame.payload, limits.maxMessage);
}

/** Close codes a WebSocket endpoint may send (the set the ws package accepts). */
export function sendableCloseCode(code: number): boolean {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
}

/** Truncate to at most `max` UTF-8 bytes without cutting a character in half. */
export function clipUtf8(s: string, max = MAX_REASON_BYTES): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return b;
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // back off to a character start
  return b.subarray(0, end);
}

export function encodeClose(conn: number, code: number, reason: string): Buffer {
  const r = clipUtf8(reason);
  const p = Buffer.allocUnsafe(2 + r.length);
  p.writeUInt16BE(sendableCloseCode(code) ? code : 1000, 0);
  r.copy(p, 2);
  return encodeFrame(FrameType.Close, conn, p);
}

/** Close code and reason, with a code the receiver may pass on (others become 1000), or null if the reason is not UTF-8. */
export function closeInfo(frame: Frame): { code: number; reason: string } | null {
  const code = frame.payload.readUInt16BE(0);
  try {
    const reason = utf8.decode(frame.payload.subarray(2));
    return { code: sendableCloseCode(code) ? code : 1000, reason };
  } catch {
    return null;
  }
}

export function encodeBye(reason: string): Buffer {
  return encodeFrame(FrameType.Bye, 0, clipUtf8(reason));
}

export function byeReason(frame: Frame): string | null {
  try {
    return utf8.decode(frame.payload);
  } catch {
    return null;
  }
}

export function encodePing(nonce: Uint8Array): Buffer {
  if (nonce.length !== PING_BYTES) throw new RangeError('ping payload is 8 bytes');
  return encodeFrame(FrameType.Ping, 0, nonce);
}

export function encodePong(ping: Frame): Buffer {
  return encodeFrame(FrameType.Pong, 0, ping.payload);
}
