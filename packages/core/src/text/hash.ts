import { forEachUtf8Byte } from './utf8';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function hashText(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  forEachUtf8Byte(text, (byte) => {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  });
  return hash.toString(16).padStart(8, '0');
}
