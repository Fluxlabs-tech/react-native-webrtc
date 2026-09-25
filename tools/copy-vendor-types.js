// The typings bob emits import ./vendor/event-target-shim, which tsc does not copy: without it,
// RTCPeerConnection and the other event targets lose addEventListener in apps.
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'src', 'vendor', 'event-target-shim', 'index.d.ts');
const to = path.join(__dirname, '..', 'lib', 'typescript', 'vendor', 'event-target-shim', 'index.d.ts');

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
