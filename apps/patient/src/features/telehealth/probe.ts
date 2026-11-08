import type { DeviceCheck, Verdict } from './types.js';

/** Below this the connection is reported as not good enough for video. A rough browser estimate, not a measurement. */
export const MIN_DOWNLINK_MBPS = 1.5;

export type Probe = () => Promise<DeviceCheck>;

async function can(constraints: MediaStreamConstraints): Promise<Verdict> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((t) => t.stop());
    return 'pass';
  } catch {
    return 'fail';
  }
}

/** Browser check: asks for the camera and the microphone (and stops them at once); bandwidth from the connection estimate if the browser has one. */
export const browserProbe: Probe = async () => {
  const hasMedia =
    typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
  const [camera, mic] = hasMedia
    ? [await can({ video: true }), await can({ audio: true })]
    : (['fail', 'fail'] as Verdict[]);
  const downlink = (navigator as Navigator & { connection?: { downlink?: number } }).connection
    ?.downlink;
  // Unknown is reported as a fail: the patient is told we could not measure it, never that it is good.
  const bandwidth: Verdict =
    downlink !== undefined && downlink >= MIN_DOWNLINK_MBPS ? 'pass' : 'fail';
  return { camera: camera as Verdict, mic: mic as Verdict, bandwidth };
};
