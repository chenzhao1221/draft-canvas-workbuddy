/**
 * jsdom shims for CodeMirror 6 (T-38). jsdom does not implement Range#getClientRects, which the
 * selection layer calls while measuring. Returning no rectangles keeps the editor mountable; layout is
 * irrelevant to these tests. Nothing here changes the panel or the editor source.
 */
const rangeProto = Range.prototype as Range & {
  getClientRects?: () => DOMRectList;
  getBoundingClientRect?: () => DOMRect;
};

if (typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = () => [] as unknown as DOMRectList;
}

if (typeof rangeProto.getBoundingClientRect !== 'function') {
  rangeProto.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
}
