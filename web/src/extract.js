// Extraction of text lines from .docx / .pdf files.
// Each line: { text, bold, images: [dataUri], list?: {depth, ordered, group} }
//  - bold: the fragment is (mostly) bold — teachers often mark the correct
//    option this way.
//  - images: inline pictures attached to that paragraph.
//  - list: present when the line came from a Word auto-numbered/bulleted
//    list; the numbering itself is NOT in the text, so the parser needs
//    this structure to recognize questions and options.
// Soft line breaks inside a paragraph are split into separate lines — many
// exam documents put a question and all its options in one paragraph.
//
// The .docx reader parses the OOXML directly (fflate synchronous unzip +
// DOMParser). This is deliberate: it gives per-fragment bold, real list
// levels, and — unlike timer-based converters — is immune to background-tab
// timer throttling that turned each file into a ~25s wait.

import { unzipSync, strFromU8 } from 'fflate';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function extractLines(file) {
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (name.endsWith('.docx')) return extractDocx(buffer);
  if (name.endsWith('.pdf')) return extractPdf(buffer);
  throw new Error(`סוג קובץ לא נתמך: ${file.name} (רק .docx או .pdf)`);
}

// --- docx -------------------------------------------------------------------

// Invisible bidi control marks (RLM/LRM etc.) break marker regexes like "א."
const BIDI_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function u8ToBase64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function childrenByName(el, localName) {
  return [...el.children].filter((c) => c.localName === localName);
}

function firstByName(el, localName) {
  return [...el.getElementsByTagName('*')].find((c) => c.localName === localName);
}

function extractDocx(arrayBuffer) {
  const zip = unzipSync(new Uint8Array(arrayBuffer));
  const docXml = zip['word/document.xml'];
  if (!docXml) throw new Error('קובץ Word לא תקין (חסר document.xml)');
  const doc = parseXml(strFromU8(docXml));

  // Relationship id → media data-URI (only real raster images).
  const relImages = new Map();
  const relsEntry = zip['word/_rels/document.xml.rels'];
  if (relsEntry) {
    const rels = parseXml(strFromU8(relsEntry));
    for (const rel of rels.getElementsByTagName('*')) {
      if (rel.localName !== 'Relationship') continue;
      const target = rel.getAttribute('Target') || '';
      const ext = target.split('.').pop().toLowerCase();
      if (!IMAGE_MIME[ext]) continue;
      const path = 'word/' + target.replace(/^\//, '').replace(/^word\//, '');
      const data = zip[path] || zip[target.replace(/^\//, '')];
      if (data) {
        relImages.set(
          rel.getAttribute('Id'),
          `data:${IMAGE_MIME[ext]};base64,${u8ToBase64(data)}`,
        );
      }
    }
  }

  // numId → {ilvl → isBullet}
  const numFormats = new Map();
  const numberingEntry = zip['word/numbering.xml'];
  if (numberingEntry) {
    const numbering = parseXml(strFromU8(numberingEntry));
    const absFormats = new Map(); // abstractNumId → {ilvl → fmt}
    for (const el of numbering.getElementsByTagName('*')) {
      if (el.localName === 'abstractNum') {
        const absId = el.getAttribute('w:abstractNumId');
        const levels = {};
        for (const lvl of childrenByName(el, 'lvl')) {
          const ilvl = lvl.getAttribute('w:ilvl');
          const fmt = firstByName(lvl, 'numFmt')?.getAttribute('w:val') || 'decimal';
          levels[ilvl] = fmt;
        }
        absFormats.set(absId, levels);
      }
    }
    for (const el of numbering.getElementsByTagName('*')) {
      if (el.localName === 'num') {
        const numId = el.getAttribute('w:numId');
        const absId = firstByName(el, 'abstractNumId')?.getAttribute('w:val');
        numFormats.set(numId, absFormats.get(absId) || {});
      }
    }
  }

  const lines = [];

  const processParagraph = (p) => {
    // List info from paragraph properties.
    let list = null;
    const pPr = childrenByName(p, 'pPr')[0];
    if (pPr) {
      const numPr = firstByName(pPr, 'numPr');
      if (numPr) {
        const numId = firstByName(numPr, 'numId')?.getAttribute('w:val');
        const ilvl = parseInt(firstByName(numPr, 'ilvl')?.getAttribute('w:val') || '0', 10);
        if (numId && numId !== '0') {
          const fmt = (numFormats.get(numId) || {})[ilvl] || 'decimal';
          list = { depth: ilvl, ordered: fmt !== 'bullet', group: `n${numId}` };
        }
      }
    }

    // Walk runs, building fragments split on soft line breaks.
    const paraImages = [];
    const nestedParagraphs = [];
    let fragments = [{ text: '', boldChars: 0 }];
    const frag = () => fragments[fragments.length - 1];

    const walkRun = (r) => {
      const rPr = childrenByName(r, 'rPr')[0];
      const boldEl = rPr && childrenByName(rPr, 'b')[0];
      const boldVal = boldEl ? boldEl.getAttribute('w:val') : null;
      const bold = !!boldEl && boldVal !== '0' && boldVal !== 'false';
      for (const child of r.children) {
        switch (child.localName) {
          case 't': {
            const t = child.textContent;
            frag().text += t;
            if (bold) frag().boldChars += t.trim().length;
            break;
          }
          case 'br':
          case 'cr':
            fragments.push({ text: '', boldChars: 0 });
            break;
          case 'tab':
            frag().text += ' ';
            break;
          case 'drawing':
          case 'pict':
          case 'object': {
            for (const el of child.getElementsByTagName('*')) {
              if (el.localName === 'blip') {
                const rid =
                  el.getAttribute('r:embed') || el.getAttribute('r:link');
                const img = rid && relImages.get(rid);
                if (img) paraImages.push(img);
              }
              // Text boxes inside drawings can hold real content.
              if (el.localName === 'txbxContent') nestedParagraphs.push(el);
            }
            break;
          }
          default:
            break;
        }
      }
    };

    for (const child of p.children) {
      if (child.localName === 'r') walkRun(child);
      else if (child.localName === 'hyperlink') {
        for (const r of childrenByName(child, 'r')) walkRun(r);
      }
    }

    fragments.forEach((f, i) => {
      const text = f.text.replace(BIDI_MARKS_RE, '').replace(/\s+/g, ' ').trim();
      if (!text && !(i === 0 && paraImages.length)) return;
      lines.push({
        text,
        bold: text.length > 0 && f.boldChars >= text.replace(/\s/g, '').length * 0.6,
        images: i === 0 ? paraImages : [],
        list,
      });
    });

    for (const box of nestedParagraphs) walkBody(box);
  };

  const walkBody = (root) => {
    for (const child of root.children) {
      if (child.localName === 'p') processParagraph(child);
      else if (child.children.length) walkBody(child);
    }
  };

  const body = firstByName(doc.documentElement, 'body') || doc.documentElement;
  walkBody(body);
  return lines;
}

// --- pdf --------------------------------------------------------------------

async function extractPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Group text items into visual lines by their Y coordinate.
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({
        x: item.transform[4],
        w: item.width || 0,
        str: item.str.replace(BIDI_MARKS_RE, '').replace(/\s+/g, ' '),
      });
    }
    const sortedYs = [...rows.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const text = reconstructPdfLine(rows.get(y));
      if (text) lines.push({ text, bold: false, images: [] });
    }
  }
  return lines;
}

const BRACKET_MIRROR = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
};

// Rebuilds one visual PDF line into logical reading order. Handles PDFs that
// emit each character as its own item, in visual (reversed) Hebrew order,
// with fake-bold double-drawn glyphs.
function reconstructPdfLine(items) {
  items.sort((a, b) => a.x - b.x);

  // Drop fake-bold duplicates: same text drawn twice at (almost) the same x.
  const glyphs = [];
  for (const item of items) {
    const prev = glyphs[glyphs.length - 1];
    if (
      prev &&
      prev.str === item.str &&
      Math.abs(item.x - prev.x) < Math.max(1, prev.w * 0.6)
    ) {
      continue;
    }
    glyphs.push(item);
  }

  // Insert spaces based on horizontal gaps between adjacent glyphs.
  const seq = [];
  for (let i = 0; i < glyphs.length; i++) {
    if (i > 0) {
      const prev = glyphs[i - 1];
      const gap = glyphs[i].x - (prev.x + prev.w);
      const charW = Math.max(prev.w / Math.max(prev.str.length, 1), 2);
      if (gap > charW * 0.4) seq.push(' ');
    }
    seq.push(...glyphs[i].str);
  }

  const joined = seq.join('').replace(/\s+/g, ' ').trim();
  if (!/[֐-׿]/.test(joined)) return joined;

  // Character-fragmented lines (one item per glyph) mean the PDF stores the
  // text in visual order — reverse it, then restore LTR runs (Latin/digits).
  const avgLen =
    glyphs.reduce((s, g) => s + g.str.trim().length, 0) / Math.max(glyphs.length, 1);
  if (glyphs.length < 4 || avgLen > 2) return joined;

  const rev = [...seq].reverse();
  const out = [];
  const isLtrChar = (c) => /[A-Za-z0-9]/.test(c);
  const isLtrJoin = (c) => /[()[\].,;:+\-*/=_%'"<>!?#&]/.test(c);
  let i = 0;
  while (i < rev.length) {
    if (isLtrChar(rev[i])) {
      let j = i;
      let lastStrong = i;
      while (
        j < rev.length &&
        (isLtrChar(rev[j]) || isLtrJoin(rev[j]) || rev[j] === ' ')
      ) {
        if (isLtrChar(rev[j])) lastStrong = j;
        j++;
      }
      // Include trailing punctuation only up to the last strong LTR char,
      // so Hebrew sentence punctuation isn't swallowed.
      out.push(...rev.slice(i, lastStrong + 1).reverse());
      i = lastStrong + 1;
    } else {
      // Brackets rendered in the RTL segments are mirrored by the reversal.
      out.push(BRACKET_MIRROR[rev[i]] || rev[i]);
      i++;
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
