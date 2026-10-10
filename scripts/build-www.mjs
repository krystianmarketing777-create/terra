// Kopiuje pliki strony do www/ (katalog, który Capacitor pakuje do aplikacji jako zapas offline).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const FILES = ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of FILES) cpSync(f, `www/${f}`);
console.log('www/ gotowe:', FILES.length, 'plików');
