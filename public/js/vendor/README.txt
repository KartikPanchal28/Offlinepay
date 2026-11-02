Optional: QR scanning on browsers that lack the built-in BarcodeDetector (iPhone Safari, Firefox).

  1. npm install jsqr            (anywhere, once)
  2. copy node_modules/jsqr/dist/jsQR.js into this folder, keeping the name  jsQR.js
  3. open the app once while online (the service worker then caches it for offline use)

The app only loads this file when it exists AND the browser has no BarcodeDetector.
Without it, those browsers can still pay and receive using "Enter a code" (paste or type).
jsQR is MIT licensed: https://github.com/cozmo/jsQR
