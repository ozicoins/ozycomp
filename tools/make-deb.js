'use strict';
/**
 * Pure-Node .deb packer — produces a real Debian binary package without dpkg,
 * fpm, or GNU ar. Needed because macOS `ar` (BSD) cannot write the archive
 * layout a .deb requires and electron-builder/fpm emits an empty 96-byte ar
 * on this host.
 *
 * A .deb is an `ar` archive:
 *   debian-binary       4 bytes: "2.0\n"
 *   control.tar.*       package metadata + maintainer scripts
 *   data.tar.*          the payload files, laid out under /
 *
 * Usage: node tools/make-deb.js <unpackedDir> <out.deb> <arch>
 *   arch: amd64 | arm64
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const PKG = require(path.join(__dirname, '..', 'package.json'));

// ── ustar writer ────────────────────────────────────────────────────────────
// One 512-byte header + data padded to 512. name<=100, prefix<=155 (split at /).
function octal(n, width) {
  const s = n.toString(8).padStart(width - 1, '0');
  return s.slice(0, width - 1) + '\0';
}
function tarHeader(name, mode, uid, gid, size, mtime, typeflag, uname, gname) {
  const h = Buffer.alloc(512, 0);
  const put = (str, off, len) => h.write(String(str), off, len, 'utf8');
  // name + prefix: split long names so basename fits in 100, rest in 155
  let base = name, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 100);
    if (i < 0 || Buffer.byteLength(name.slice(i + 1)) > 100) {
      throw new Error(`tar name too long and unsplittable: ${name}`);
    }
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  put(base.slice(0, 100), 0, 100);
  put(octal(mode & 0o7777, 8), 100, 8);
  put(octal(uid, 8), 108, 8);
  put(octal(gid, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime / 1000), 12), 136, 12);
  h.write('        ', 148, 8, 'utf8');   // checksum = spaces while computing
  h.write(typeflag, 156, 1, 'utf8');
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  put((uname || 'root').slice(0, 32), 265, 32);
  put((gname || 'root').slice(0, 32), 297, 32);
  put(prefix.slice(0, 155), 345, 155);
  // checksum: sum of all 512 bytes with the checksum field as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum, 8), 148, 8, 'utf8');
  return h;
}
function tarEntry(name, mode, size, mtime, typeflag, data) {
  const parts = [tarHeader(name, mode, 0, 0, size, mtime, typeflag, 'root', 'root')];
  if (typeflag === '0' && size > 0) {
    parts.push(data);
    const pad = (512 - (size % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  return Buffer.concat(parts);
}
function tarEnd() { return Buffer.alloc(1024, 0); }

// ── ar writer ───────────────────────────────────────────────────────────────
// header: name(16) mtime(12) uid(6) gid(6) mode(8) size(10) magic(2)="`\n"
function arHeader(name, size, mtime) {
  const h = Buffer.alloc(60, ' ');
  h.write(name.padEnd(16, ' '), 0, 16, 'utf8');
  h.write(String(Math.floor(mtime / 1000)).padEnd(12, ' '), 16, 12, 'utf8');
  h.write('0     ', 28, 6, 'utf8');
  h.write('0     ', 34, 6, 'utf8');
  h.write('100644  ', 40, 8, 'utf8');
  h.write(String(size).padEnd(10, ' '), 48, 10, 'utf8');
  h.write('`\n', 58, 2, 'utf8');
  return h;
}
function arArchive(members) {
  const out = [Buffer.from('!<arch>\n', 'utf8')];
  for (const m of members) {
    out.push(arHeader(m.name, m.data.length, m.mtime));
    out.push(m.data);
    if (m.data.length % 2) out.push(Buffer.from('\n')); // ar pads odd members
  }
  return Buffer.concat(out);
}

// ── walk a directory into data.tar ──────────────────────────────────────────
function* walk(dir, prefix) {
  const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { yield { abs, rel, type: 'dir' }; yield* walk(abs, rel); }
    else if (e.isSymbolicLink()) { yield { abs, rel, type: 'symlink', target: fs.readlinkSync(abs) }; }
    else if (e.isFile()) { yield { abs, rel, type: 'file' }; }
  }
}

function buildDataTar(unpackedDir) {
  const parts = [];
  const now = Date.now();
  // every entry lands under /opt/OzyComp (Debian packages opt-in apps there)
  const rootName = 'opt/OzyComp';
  parts.push(tarEntry('opt/', 0o755, 0, now, '5'));
  parts.push(tarEntry(`${rootName}/`, 0o755, 0, now, '5'));
  for (const it of walk(unpackedDir, '')) {
    const rel = `${rootName}/${it.rel}`;
    const st = fs.statSync(it.abs);
    const mode = st.mode & 0o7777;
    const mtime = Math.floor(st.mtimeMs);
    if (it.type === 'dir') {
      parts.push(tarEntry(`${rel}/`, 0o755, 0, mtime, '5'));
    } else if (it.type === 'symlink') {
      const h = tarHeader(rel, 0o777, 0, 0, 0, mtime, '2', 'root', 'root');
      h.write(it.target.slice(0, 100), 157, 100, 'utf8');
      parts.push(h);
    } else {
      parts.push(tarEntry(rel, mode, st.size, mtime, '0', fs.readFileSync(it.abs)));
    }
  }
  // icons + desktop entry
  const iconRoot = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'icons', 'electron-linux');
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const png = path.join(iconRoot, `${size}x${size}.png`);
    if (fs.existsSync(png)) {
      const dest = `usr/share/icons/hicolor/${size}x${size}/apps/ozycomp.png`;
      const st = fs.statSync(png);
      parts.push(tarEntry(dest, 0o644, st.size, now, '0', fs.readFileSync(png)));
    }
  }
  const desktop = [
    '[Desktop Entry]',
    'Name=OzyComp',
    'Comment=Local-first multi-agent harness',
    'Exec=/opt/OzyComp/ozycomp %U',
    'Icon=ozycomp',
    'Type=Application',
    'Categories=Development;',
    'StartupNotify=true',
    'Terminal=false',
    '',
  ].join('\n');
  parts.push(tarEntry('usr/share/applications/ozycomp.desktop', 0o644, Buffer.byteLength(desktop), now, '0', Buffer.from(desktop)));
  parts.push(tarEnd());
  return Buffer.concat(parts);
}

function buildControlTar(arch, installedSizeKb) {
  const now = Date.now();
  const control = [
    `Package: ozycomp`,
    `Version: ${PKG.version}`,
    `Architecture: ${arch}`,
    `Maintainer: ${PKG.linux?.maintainer ?? 'OzyComp <dev@ozycomp.app>'}`,
    `Installed-Size: ${installedSizeKb}`,
    `Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0`,
    `Recommends: libappindicator3-1`,
    `Section: devel`,
    `Priority: optional`,
    `Homepage: ${PKG.homepage ?? 'https://ozycomp.app'}`,
    `Description: OzyComp — local multi-agent harness`,
    ` ${(PKG.description ?? '').replace(/\n+/g, ' ')}`,
    '',
  ].join('\n');
  const postinst = [
    '#!/bin/sh',
    'set -e',
    '# SUID chrome-sandbox so the sandbox helper can drop privileges',
    'if [ -f /opt/OzyComp/chrome-sandbox ]; then',
    '  chown root:root /opt/OzyComp/chrome-sandbox || true',
    '  chmod 4755 /opt/OzyComp/chrome-sandbox || true',
    'fi',
    '# desktop entry + icon cache',
    'update-desktop-database /usr/share/applications || true',
    'gtk-update-icon-cache /usr/share/icons/hicolor || true',
    '',
  ].join('\n');
  const postrm = [
    '#!/bin/sh',
    'set -e',
    'update-desktop-database /usr/share/applications || true',
    'gtk-update-icon-cache /usr/share/icons/hicolor || true',
    '',
  ].join('\n');
  const parts = [];
  parts.push(tarEntry('./control', 0o644, Buffer.byteLength(control), now, '0', Buffer.from(control)));
  parts.push(tarEntry('./postinst', 0o755, Buffer.byteLength(postinst), now, '0', Buffer.from(postinst)));
  parts.push(tarEntry('./postrm', 0o755, Buffer.byteLength(postrm), now, '0', Buffer.from(postrm)));
  parts.push(tarEnd());
  return Buffer.concat(parts);
}

function gz(buf) { return require('node:zlib').gzipSync(buf, { level: 9 }); }
function xz(buf) {
  const tmp = `/tmp/ozydeb-data-${process.pid}`;
  const out = `${tmp}.xz`;
  fs.writeFileSync(tmp, buf);
  try {
    execSync(`xz -zkc -T0 "${tmp}" > "${out}"`, { maxBuffer: 1 << 30 });
    return fs.readFileSync(out);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(out); } catch {}
  }
}

function main() {
  const [unpackedDir, outPath, arch] = process.argv.slice(2);
  if (!unpackedDir || !outPath || !arch) {
    console.error('usage: node tools/make-deb.js <unpackedDir> <out.deb> <amd64|arm64>');
    process.exit(2);
  }
  const resolved = path.resolve(unpackedDir);
  if (!fs.existsSync(resolved)) { console.error(`missing: ${resolved}`); process.exit(2); }

  const dataTar = buildDataTar(resolved);
  const installedSizeKb = Math.ceil(dataTar.length / 1024);
  const controlTar = buildControlTar(arch, installedSizeKb);

  const now = Date.now();
  const deb = arArchive([
    { name: 'debian-binary', data: Buffer.from('2.0\n'), mtime: now },
    { name: 'control.tar.gz', data: gz(controlTar), mtime: now },
    { name: 'data.tar.xz', data: xz(dataTar), mtime: now },
  ]);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, deb);
  const sha = crypto.createHash('sha256').update(deb).digest('hex');
  console.log(`wrote ${outPath} (${deb.length} bytes, sha256 ${sha.slice(0, 16)}…)`);
}
main();
