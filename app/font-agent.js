// Built-in Figma font agent: lets figma.com use the fonts installed on this machine.
//
// Figma's web app asks a helper on http://127.0.0.1:44950 for the list of local fonts
// and for the font files themselves. Figma ships that helper for macOS and Windows only;
// this is a dependency-free port of figma-agent-linux (https://github.com/neetly/figma-agent-linux,
// MIT, Copyright (c) 2025 Hikari Hayashi) so figmux works without installing it separately.
// The font-preview endpoint (an SVG of the family name in the font picker) is not ported;
// Figma falls back to plain text, as it does when the original agent has previews disabled.
//
// If something else (e.g. figma-agent-linux) already holds the port, we leave it be.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = 44950;
const FIGMA_ORIGIN = 'https://www.figma.com';
// Only answer requests addressed to us by name, so a page can't reach the agent through a
// DNS name it has rebound to 127.0.0.1 (DNS rebinding).
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// Client version Figma expects; same values figma-agent-linux reports (from the official Windows client).
const PACKAGE = '125.9.10';
const VERSION = 23;

const FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.otf', '.otc']);
const CONTENT_TYPES = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.ttc': 'font/collection', '.otc': 'font/collection' };
const FALLBACK_FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'), path.join(os.homedir(), '.fonts')];

const log = (...args) => console.log('figmux font agent:', ...args);
// FIGMUX_DEBUG=1 logs every request, for troubleshooting Figma not seeing fonts.
const debug = process.env.FIGMUX_DEBUG ? log : () => {};

// ---------------------------------------------------------------------------
// Finding font files

function listFontconfigFiles() {
  return new Promise((resolve, reject) => {
    execFile('fc-list', ['--format', '%{file}\n'], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.split('\n').filter(Boolean));
    });
  });
}

// Used only if fontconfig isn't available: walk the usual font folders, following symlinks once.
async function walkFontDirs(dirs) {
  const files = [];
  const visited = new Set();
  async function walk(dir) {
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch {
      return;
    }
    const id = `${stat.dev}:${stat.ino}`;
    if (visited.has(id)) return;
    visited.add(id);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await fsp.stat(full).catch(() => null))?.isDirectory())) await walk(full);
      else files.push(full);
    }
  }
  for (const dir of dirs) await walk(dir);
  return files;
}

async function findFontPaths() {
  let files;
  try {
    files = await listFontconfigFiles();
  } catch (err) {
    log('fc-list unavailable, scanning default font folders instead:', err.message);
    files = await walkFontDirs(FALLBACK_FONT_DIRS);
  }
  const paths = new Set();
  await Promise.all(
    files
      .filter((file) => FONT_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .map(async (file) => {
        try {
          paths.add(await fsp.realpath(file));
        } catch {
          // Broken symlink or removed since the listing; skip it.
        }
      }),
  );
  return paths;
}

// ---------------------------------------------------------------------------
// Reading font metadata (just the tables we need, not whole files)

const NAME = { FAMILY: 1, SUBFAMILY: 2, POSTSCRIPT: 6, TYPOGRAPHIC_FAMILY: 16, TYPOGRAPHIC_SUBFAMILY: 17, VARIATIONS_PS_PREFIX: 25 };
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

let macRoman;
try {
  macRoman = new TextDecoder('macintosh');
} catch {
  macRoman = new TextDecoder('latin1');
}
const utf16be = (buf) => {
  const swapped = Buffer.from(buf);
  swapped.swap16();
  return swapped.toString('utf16le');
};

async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  if (bytesRead < length) throw new Error('unexpected end of file');
  return buffer;
}

async function readTableDirectory(handle, offset) {
  const header = await readAt(handle, offset, 12);
  if (!SFNT_VERSIONS.has(header.readUInt32BE(0))) throw new Error('not an OpenType font');
  const numTables = header.readUInt16BE(4);
  const records = await readAt(handle, offset + 12, numTables * 16);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const r = i * 16;
    tables[records.toString('latin1', r, r + 4)] = { offset: records.readUInt32BE(r + 8), length: records.readUInt32BE(r + 12) };
  }
  return tables;
}

// Windows English is any language ID whose primary language is 0x09; Mac English is 0.
const isEnglish = (platform, language) => (platform === 3 && (language & 0xff) === 0x09) || (platform === 1 && language === 0);

function parseNameTable(buf) {
  const count = buf.readUInt16BE(2);
  const storage = buf.readUInt16BE(4);
  const byId = new Map();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const language = buf.readUInt16BE(r + 4);
    const nameId = buf.readUInt16BE(r + 6);
    const start = storage + buf.readUInt16BE(r + 10);
    const raw = buf.subarray(start, start + buf.readUInt16BE(r + 8));
    let text;
    if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) text = utf16be(raw);
    else if (platform === 1 && encoding === 0) text = macRoman.decode(raw);
    else continue;
    if (!byId.has(nameId)) byId.set(nameId, []);
    byId.get(nameId).push({ text, english: isEnglish(platform, language), mac: platform === 1 });
  }
  // English if there is one, otherwise the first usable string (like skrifa's english_or_first).
  // Unicode/Windows strings win over the legacy Mac ones, which are often stale or mis-encoded.
  return (id) => {
    const entries = byId.get(id);
    if (!entries) return null;
    const pick = entries.find((e) => e.english && !e.mac) || entries.find((e) => e.english) || entries.find((e) => !e.mac) || entries[0];
    return pick.text;
  };
}

// 16.16 fixed-point → float, printed like a 32-bit float (16.739105, not 16.739105224609375)
// to match the original agent's output.
const fixed = (buf, offset) => toF32Shortest(buf.readInt32BE(offset) / 65536);
function toF32Shortest(value) {
  const f = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(f.toPrecision(digits));
    if (Math.fround(candidate) === f) return candidate;
  }
  return f;
}
const postscriptSafe = (s) => s.replace(/[^A-Za-z0-9]/g, '');

async function readFont(handle, offset, index) {
  const tables = await readTableDirectory(handle, offset);
  if (!tables.name) throw new Error('missing name table');
  const name = parseNameTable(await readAt(handle, tables.name.offset, tables.name.length));

  let weight = 400;
  let widthClass = 5;
  let isItalic = false;
  let isOblique = false;
  if (tables['OS/2'] && tables['OS/2'].length >= 64) {
    const os2 = await readAt(handle, tables['OS/2'].offset, 64);
    weight = os2.readUInt16BE(4);
    widthClass = os2.readUInt16BE(6);
    const fsSelection = os2.readUInt16BE(62);
    isItalic = (fsSelection & 0x0001) !== 0;
    isOblique = !isItalic && (fsSelection & 0x0200) !== 0;
  } else if (tables.head) {
    const macStyle = (await readAt(handle, tables.head.offset + 44, 2)).readUInt16BE(0);
    weight = macStyle & 0x1 ? 700 : 400;
    isItalic = (macStyle & 0x2) !== 0;
  }
  if (widthClass < 1 || widthClass > 9) widthClass = 5;

  const axes = [];
  const namedInstances = [];
  if (tables.fvar) {
    const fvar = await readAt(handle, tables.fvar.offset, tables.fvar.length);
    const axesOffset = fvar.readUInt16BE(4);
    const axisCount = fvar.readUInt16BE(8);
    const axisSize = fvar.readUInt16BE(10);
    const instanceCount = fvar.readUInt16BE(12);
    const instanceSize = fvar.readUInt16BE(14);
    for (let i = 0; i < axisCount; i++) {
      const a = axesOffset + i * axisSize;
      axes.push({
        tag: fvar.toString('latin1', a, a + 4),
        min: fixed(fvar, a + 4),
        default: fixed(fvar, a + 8),
        max: fixed(fvar, a + 12),
        hidden: (fvar.readUInt16BE(a + 16) & 0x0001) !== 0,
        name: name(fvar.readUInt16BE(a + 18)),
      });
    }
    const hasPsNameId = instanceSize >= axisCount * 4 + 6;
    const instancesOffset = axesOffset + axisCount * axisSize;
    for (let i = 0; i < instanceCount; i++) {
      const r = instancesOffset + i * instanceSize;
      const subfamily = name(fvar.readUInt16BE(r));
      const coordinates = axes.map((_, j) => fixed(fvar, r + 4 + j * 4));
      const psNameId = hasPsNameId ? fvar.readUInt16BE(r + 4 + axisCount * 4) : 0xffff;
      let postscript = psNameId !== 0xffff ? name(psNameId) : null;
      if (!postscript) {
        // Adobe Tech Note 5902: <variations prefix or typographic family>-<subfamily>
        const prefix = name(NAME.VARIATIONS_PS_PREFIX) ?? (name(NAME.TYPOGRAPHIC_FAMILY) && postscriptSafe(name(NAME.TYPOGRAPHIC_FAMILY)));
        if (prefix && subfamily) postscript = `${prefix}-${postscriptSafe(subfamily)}`;
      }
      namedInstances.push({ subfamily, postscript, coordinates });
    }
  }

  return {
    index,
    family: name(NAME.TYPOGRAPHIC_FAMILY) ?? name(NAME.FAMILY),
    subfamily: name(NAME.TYPOGRAPHIC_SUBFAMILY) ?? name(NAME.SUBFAMILY),
    postscript: name(NAME.POSTSCRIPT),
    weight,
    widthClass,
    isItalic,
    isOblique,
    axes,
    namedInstances,
  };
}

async function readFontFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const head = await readAt(handle, 0, 12);
    const offsets = [];
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const numFonts = head.readUInt32BE(8);
      const table = await readAt(handle, 12, numFonts * 4);
      for (let i = 0; i < numFonts; i++) offsets.push(table.readUInt32BE(i * 4));
    } else {
      offsets.push(0);
    }
    const fonts = [];
    for (const [index, offset] of offsets.entries()) {
      try {
        fonts.push(await readFont(handle, offset, index));
      } catch {
        // Skip a broken face in a collection; keep the rest.
      }
    }
    return fonts;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Font cache, rescanned on each font list request (cheap: only changed files are re-read)

const fontFiles = new Map(); // realpath -> { fingerprint, modifiedAt, fonts }
let scanning = null;

function scanFontFiles() {
  // Overlapping requests share one scan.
  scanning ??= (async () => {
    try {
      const paths = await findFontPaths();
      for (const known of fontFiles.keys()) if (!paths.has(known)) fontFiles.delete(known);

      const queue = [...paths];
      const worker = async () => {
        for (let file = queue.pop(); file; file = queue.pop()) {
          try {
            const stat = await fsp.stat(file);
            const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeMs}`;
            if (fontFiles.get(file)?.fingerprint === fingerprint) continue;
            const fonts = await readFontFile(file);
            if (fonts.length) fontFiles.set(file, { fingerprint, modifiedAt: Math.floor(stat.mtimeMs / 1000), fonts });
            else fontFiles.delete(file);
          } catch {
            fontFiles.delete(file);
          }
        }
      };
      await Promise.all(Array.from({ length: 16 }, worker));
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

// ---------------------------------------------------------------------------
// Response payloads (same shape as figma-agent-linux)

// OS/2 usWidthClass ↔ width percentage, as in the OpenType spec.
const WIDTH_PERCENT = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
function toWidthClass(percent) {
  if (percent <= WIDTH_PERCENT[0]) return 1;
  if (percent >= WIDTH_PERCENT[8]) return 9;
  const i = WIDTH_PERCENT.findIndex((p) => p >= percent);
  const lo = WIDTH_PERCENT[i - 1];
  const hi = WIDTH_PERCENT[i];
  return Math.round(i + (percent - lo) / (hi - lo));
}

function fontPayloads(font, modifiedAt) {
  const base = {
    family: font.family ?? '',
    style: font.subfamily ?? '',
    postscript: font.postscript ?? '',
    weight: Math.round(font.weight),
    stretch: font.widthClass,
    italic: font.isItalic || font.isOblique,
    ...(font.axes.length && {
      variationAxes: font.axes.map((a) => ({ tag: a.tag, name: a.name ?? '', value: a.default, min: a.min, max: a.max, default: a.default, hidden: a.hidden })),
    }),
    modified_at: modifiedAt,
    user_installed: true,
  };
  if (!font.namedInstances.length) return [base];

  // A variable font is listed once per named instance (Regular, Bold, ...).
  return font.namedInstances.map((instance) => {
    const payload = { ...base, style: instance.subfamily ?? '', postscript: instance.postscript ?? '' };
    let italic = font.isItalic;
    let oblique = font.isOblique;
    payload.variationAxes = base.variationAxes.map((axis, i) => {
      const value = instance.coordinates[i];
      if (axis.tag === 'wght') payload.weight = Math.round(value);
      if (axis.tag === 'wdth') payload.stretch = toWidthClass(value);
      if (axis.tag === 'ital') italic = value !== 0;
      if (axis.tag === 'slnt') oblique = value !== 0;
      return { ...axis, value };
    });
    payload.italic = italic || oblique;
    return payload;
  });
}

// ---------------------------------------------------------------------------
// HTTP server

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, value, headers) {
  send(res, 200, JSON.stringify(value), { ...headers, 'Content-Type': 'application/json' });
}

async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'Forbidden');

  const cors = { Vary: 'Origin' };
  if (req.headers.origin === FIGMA_ORIGIN) cors['Access-Control-Allow-Origin'] = FIGMA_ORIGIN;

  // CORS / Private Network Access preflight
  if (req.method === 'OPTIONS') {
    return send(res, 204, null, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Private-Network': 'true',
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', cors);

  const url = new URL(req.url, `http://${req.headers.host}`);
  switch (url.pathname) {
    case '/figma/version':
      return sendJson(res, { package: PACKAGE, version: VERSION }, cors);

    case '/figma/font-files': {
      await scanFontFiles();
      const files = {};
      for (const [file, entry] of fontFiles) files[file] = entry.fonts.flatMap((font) => fontPayloads(font, entry.modifiedAt));
      return sendJson(res, { fontFiles: files, modified_at: null, modified_fonts: null, package: PACKAGE, version: VERSION }, cors);
    }

    case '/figma/font-file': {
      // Only files from the scanned font list can be served, never arbitrary paths.
      const file = url.searchParams.get('file');
      if (!file || !fontFiles.has(file)) return send(res, 404, 'Not Found', cors);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        fontFiles.delete(file);
        return send(res, 404, 'Not Found', cors);
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Last-Modified': stat.mtime.toUTCString(),
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }

    default:
      // Includes /figma/font-preview, which isn't implemented (see top of file).
      return send(res, 404, 'Not Found', cors);
  }
}

let server = null;

function start() {
  if (server) return;
  server = http.createServer((req, res) => {
    res.on('finish', () => debug(`${req.method} ${req.url.slice(0, 120)} host=${req.headers.host} origin=${req.headers.origin} -> ${res.statusCode}`));
    handle(req, res).catch((err) => {
      console.error('figmux font agent: request failed', err);
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') log(`port ${PORT} is already in use (another font agent?); using that instead`);
    else console.error('figmux font agent: server error', err);
    server = null;
  });
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}`);
    // Warm the cache so Figma's first request is quick.
    scanFontFiles().then(() => log(`${fontFiles.size} font files indexed`));
  });
}

function stop() {
  server?.close();
  server = null;
}

module.exports = { start, stop, readFontFile, scanFontFiles, fontFiles, handle };
