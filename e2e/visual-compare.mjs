import { PNG } from "pngjs";

// Repeated captures of the SAME build showed 17 border pixels (delta 1)
// and 26 icon pixels (delta <=4). Bound both area and amplitude: never
// tolerate a displaced control, missing text/banner, or an alpha change.
export function compareVisual(expectedBytes, actualBytes) {
  const expected = PNG.sync.read(expectedBytes);
  const actual = PNG.sync.read(actualBytes);
  if (expected.width !== actual.width || expected.height !== actual.height)
    return { passed: false, reason: "dimensions" };
  let changedPixels = 0, maxChannelDelta = 0, alphaChanged = false;
  for (let i = 0; i < actual.data.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(actual.data[i + c] - expected.data[i + c]);
      changed ||= delta > 0;
      if (c === 3) alphaChanged ||= delta > 0;
      else maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (changed) changedPixels++;
  }
  return {
    passed: !alphaChanged && changedPixels <= 32 && maxChannelDelta <= 4,
    changedPixels, maxChannelDelta, alphaChanged,
  };
}
