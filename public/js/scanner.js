// scanner.js — camera QR scanning, with no network needed.
//   1. Uses the browser's built-in BarcodeDetector (Chrome / Edge / Android).
//   2. If that is missing (e.g. iPhone Safari), uses jsQR when you have added it at
//      public/js/vendor/jsQR.js (see README). Otherwise the app falls back to "Enter code".

export const canUseCamera = () => !!navigator.mediaDevices?.getUserMedia;

let jsqrLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(true);
  jsqrLoading ||= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/jsQR.js';
    s.onload = () => resolve(!!window.jsQR);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return jsqrLoading;
}

async function makeDetector(video) {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async () => (await detector.detect(video))[0]?.rawValue || null;
      }
    } catch { /* try jsQR */ }
  }
  if (await loadJsQR()) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return async () => {
      const w = Math.min(640, video.videoWidth);
      if (!w) return null;
      canvas.width = w;
      canvas.height = Math.round((video.videoHeight * w) / video.videoWidth);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(img.data, img.width, img.height)?.data || null;
    };
  }
  return null;
}

/** Start scanning into <video>. onCode(text) is called for each new code (repeats are ignored for 3 s).
 *  Returns { stop() }. Throws an Error with .code = 'NO_CAMERA' | 'DENIED' | 'NO_DETECTOR'. */
export async function startScanner(video, onCode) {
  if (!canUseCamera()) throw Object.assign(new Error('No camera API'), { code: 'NO_CAMERA' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    throw Object.assign(e, { code: e?.name === 'NotAllowedError' ? 'DENIED' : 'NO_CAMERA' });
  }
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  await video.play().catch(() => {});

  const detect = await makeDetector(video);
  const stopStream = () => { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  if (!detect) { stopStream(); throw Object.assign(new Error('No QR detector'), { code: 'NO_DETECTOR' }); }

  let stopped = false;
  let last = '';
  let lastAt = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        const value = await detect();
        if (value && (value !== last || Date.now() - lastAt > 3000)) {
          last = value; lastAt = Date.now();
          onCode(value);
        }
      }
    } catch { /* a bad frame is fine */ }
    if (!stopped) setTimeout(tick, 150);
  };
  tick();
  return { stop() { stopped = true; stopStream(); } };
}
