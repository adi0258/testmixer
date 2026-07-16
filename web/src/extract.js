// Extraction of text lines from .docx / .pdf files.
// Each line: { text: string, bold: boolean, images: [dataUri] }.
// bold marks a fully-emphasized paragraph, commonly used by teachers to mark
// the correct option; images are inline pictures attached to that paragraph.

import mammoth from 'mammoth/mammoth.browser';
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

async function extractDocx(arrayBuffer) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = [];
  for (const el of doc.body.querySelectorAll('p, li, h1, h2, h3, h4, td')) {
    // Skip containers whose text comes from nested block elements (e.g. td > p)
    if (el.querySelector('p, li')) continue;
    const images = [...el.querySelectorAll('img')]
      .map((img) => img.src)
      .filter((src) => src.startsWith('data:image/'));
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text && images.length === 0) continue;
    const boldEl = el.querySelector('strong, b');
    const boldLen = boldEl ? boldEl.textContent.trim().length : 0;
    lines.push({
      text,
      bold: boldLen > 0 && boldLen >= text.length * 0.6,
      images,
    });
  }
  return lines;
}

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
      // PDFs sometimes store Hebrew in visual (reversed) order; detect a line
      // whose Hebrew words are reversed by checking for a trailing question
      // number pattern like "‎.1" and flip word order heuristically.
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
