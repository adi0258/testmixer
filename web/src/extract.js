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
      const text = f.text.replace(/\s+/g, ' ').trim();
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
      rows.get(y).push({ x: item.transform[4], str: item.str });
    }
    const sortedYs = [...rows.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const parts = rows.get(y).sort((a, b) => a.x - b.x);
      let text = parts.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim();
      // PDFs sometimes store Hebrew in visual (reversed) order; flip a line
      // whose punctuation pattern gives that away.
      if (looksVisuallyReversedHebrew(text)) {
        text = text.split(' ').reverse().join(' ');
      }
      if (text) lines.push({ text, bold: false, images: [] });
    }
  }
  return lines;
}

function looksVisuallyReversedHebrew(text) {
  // Hebrew text stored visually ends up with punctuation like ".1" at the
  // start-of-string when it logically belongs at the line start ("1.").
  return /[֐-׿]/.test(text) && /^[.)]\d{1,3}(\s|$)/.test(text);
}
