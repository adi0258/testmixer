// Export of shuffled versions and answer key as .docx files.

import {
  AlignmentType,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import fileSaver from 'file-saver';

const saveAs = fileSaver.saveAs || fileSaver;

const HEB_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'];
const LAT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function isHebrew(text) {
  return /[֐-׿]/.test(text);
}

function letters(hebrew) {
  return hebrew ? HEB_LETTERS : LAT_LETTERS;
}

function para(text, { bold = false, size = 24, spaceAfter = 80, heading } = {}) {
  const rtl = isHebrew(text);
  return new Paragraph({
    bidirectional: rtl,
    alignment: rtl ? undefined : AlignmentType.LEFT,
    heading,
    spacing: { after: spaceAfter },
    children: [
      new TextRun({ text, bold, size, rightToLeft: rtl, font: 'Arial' }),
    ],
  });
}

const IMAGE_TYPES = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', bmp: 'bmp' };

function imageDimensions(src) {
  // Browser only; in other environments fall back to a sensible default.
  if (typeof Image === 'undefined') return Promise.resolve({ w: 300, h: 200 });
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 300, h: 200 });
    img.src = src;
  });
}

async function imageParagraph(src) {
  const match = src.match(/^data:image\/(\w+);base64,(.*)$/s);
  const type = match && IMAGE_TYPES[match[1].toLowerCase()];
  if (!type) return null;
  const bin = atob(match[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  let { w, h } = await imageDimensions(src);
  const maxW = 380;
  if (w > maxW) {
    h = Math.round((h * maxW) / w);
    w = maxW;
  }
  return new Paragraph({
    spacing: { after: 80 },
    children: [new ImageRun({ data, type, transformation: { width: w, height: h } })],
  });
}

export async function buildVersionDoc(title, version, { single = false } = {}) {
  const children = [
    para(single ? title : `${title} — גרסה ${version.label}`, {
      bold: true,
      size: 32,
      spaceAfter: 120,
    }),
    para('שם: ____________________     ת.ז: ____________________', {
      size: 22,
      spaceAfter: 240,
    }),
  ];

  for (const [qi, q] of version.questions.entries()) {
    const hebrew = isHebrew(q.text);
    children.push(
      para(`${qi + 1}. ${q.text}`, { bold: true, spaceAfter: 60 }),
    );
    for (const src of q.images || []) {
      const imgPara = await imageParagraph(src);
      if (imgPara) children.push(imgPara);
    }
    const lets = letters(hebrew);
    q.options.forEach((o, oi) => {
      children.push(para(`${lets[oi]}. ${o.text}`, { size: 22, spaceAfter: 40 }));
    });
    children.push(para(' ', { size: 12, spaceAfter: 80 }));
  }

  return new Document({ sections: [{ children }] });
}

export function buildAnswerKeyDoc(title, versions) {
  const children = [
    para(`${title} — תשובון למורה`, { bold: true, size: 32, spaceAfter: 160 }),
  ];

  const anyCorrect = versions.some((v) =>
    v.questions.some((q) => q.options.some((o) => o.correct)),
  );

  const single = versions.length === 1;
  for (const version of versions) {
    if (!single) {
      children.push(para(`גרסה ${version.label}`, { bold: true, size: 28, spaceAfter: 100 }));
    }
    version.questions.forEach((q, qi) => {
      const hebrew = isHebrew(q.text);
      const lets = letters(hebrew);
      const correctIdx = q.options.findIndex((o) => o.correct);
      const correctTxt =
        correctIdx >= 0 ? `תשובה נכונה: ${lets[correctIdx]}` : 'תשובה נכונה: לא סומנה';
      children.push(
        para(
          `${qi + 1}. (שאלה ${q.origNum} במקור) — ${correctTxt}`,
          { size: 22, spaceAfter: 40 },
        ),
      );
    });
    children.push(para(' ', { size: 12, spaceAfter: 120 }));
  }

  if (!anyCorrect) {
    children.splice(
      1,
      0,
      para(
        'לא סומנו תשובות נכונות — התשובון מציג רק את מיפוי מספרי השאלות למקור.',
        { size: 22, spaceAfter: 160 },
      ),
    );
  }

  return new Document({ sections: [{ children }] });
}

export async function exportAll(title, versions) {
  const safeTitle = (title || 'מבחן').replace(/[\\/:*?"<>|]/g, '_');
  const single = versions.length === 1;
  for (const version of versions) {
    const blob = await Packer.toBlob(await buildVersionDoc(title, version, { single }));
    const suffix = single ? 'מעורבב' : `גרסה ${version.label}`;
    saveAs(blob, `${safeTitle} - ${suffix}.docx`);
  }
  const keyBlob = await Packer.toBlob(buildAnswerKeyDoc(title, versions));
  saveAs(keyBlob, `${safeTitle} - תשובון.docx`);
}
