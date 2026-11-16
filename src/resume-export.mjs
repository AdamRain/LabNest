import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel,
  ImageRun, Table, TableRow, TableCell, WidthType, TableLayoutType, BorderStyle, AlignmentType, VerticalAlign } from 'docx';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectPhoto } from './photo-validation.mjs';

export const resumeSections = [
  ['bio', '个人介绍'], ['research', '研究方向'], ['education', '教育经历'],
  ['projects', '项目经历'], ['publications', '论文与成果'], ['awards', '奖励与荣誉'], ['skills', '技能']
];

const bundledFont = fileURLToPath(new URL('./fonts/FandolHei-Regular.otf', import.meta.url));

function resumePhoto(photo) {
  if (!photo?.bytes?.length || !['image/png', 'image/jpeg'].includes(photo.mime)) return null;
  try {
    return inspectPhoto(photo.bytes, { mime: photo.mime });
  } catch {
    // Older uploads may contain an unreadable image; the text CV can still be exported.
    return null;
  }
}

function fitPhoto(photo, width, height) {
  const scale = Math.min(width / photo.width, height / photo.height);
  return { width: photo.width * scale, height: photo.height * scale };
}

export function publicLinks(value = '') {
  return String(value).split(/\r?\n/).map(line => {
    const [first, ...rest] = line.trim().split(/[|｜]/);
    const raw = rest.length ? rest.join('|').trim() : first.trim();
    const url = URL.parse(raw);
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { label: rest.length ? first.trim() || url.hostname : url.hostname, url: url.href };
  }).filter(Boolean);
}

function resumeFont() {
  const configured = process.env.LAB_RESUME_FONT;
  if (configured && existsSync(configured)) return { path: configured, face: process.env.LAB_RESUME_FONT_FACE };
  if (existsSync(bundledFont)) return { path: bundledFont };
  const candidates = [
    { path: '/System/Library/Fonts/Supplemental/Songti.ttc', face: 'STSongti-SC-Regular' },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', face: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf' },
    { path: 'C:/Windows/Fonts/simsun.ttc', face: 'SimSun' }
  ];
  const found = candidates.find(font => existsSync(font.path));
  if (found) return found;
  throw new Error('缺少简历中文字体，请通过 LAB_RESUME_FONT 配置可嵌入的中文字体文件。');
}

/** Export only the explicit CV projection supplied by student-site, never an account object. */
export async function resumePdf(profile, { photo: sourcePhoto } = {}) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 52, right: 52 },
    bufferPages: true, info: { Title: `${profile.name}的个人简历`, Author: profile.name, Creator: '个人简历' } });
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  try {
    const font = resumeFont();
    doc.registerFont('ResumeCJK', font.path, font.face);
    doc.font('ResumeCJK');
    const width = doc.page.width - 104;
    const photo = resumePhoto(sourcePhoto);
    const headerTop = doc.y;
    const headerWidth = width - (photo ? 92 : 0);
    if (photo) doc.image(photo.data, doc.page.width - 52 - 72, headerTop,
      { fit: [72, 96], align: 'right', valign: 'top' });
    doc.x = 52;
    doc.y = headerTop;
    doc.fontSize(26).fillColor('#122e28').text(profile.name, { width: headerWidth, lineGap: 3 });
    const subtitle = [profile.title, profile.major].filter(Boolean).join(' / ');
    if (subtitle) doc.moveDown(0.3).fontSize(11).fillColor('#4a615b').text(subtitle, { width: headerWidth, lineGap: 3 });
    if (profile.publicEmail) doc.moveDown(0.3).fontSize(10).text(profile.publicEmail,
      { width: headerWidth, link: `mailto:${profile.publicEmail}` });
    if (photo) doc.y = Math.max(doc.y, headerTop + 96);
    doc.moveDown(0.8);
    const section = (label, body) => {
      if (!body?.trim()) return;
      if (doc.y + 65 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      doc.fontSize(12).fillColor('#164d40').text(label, { width, lineGap: 2 });
      doc.moveDown(0.3).fontSize(10.2).fillColor('#202c28').text(body, { width, lineGap: 4, paragraphGap: 5 });
      doc.moveDown(0.85);
    };
    for (const [key, label] of resumeSections) section(label, profile[key]);
    const links = publicLinks(profile.links);
    if (links.length) {
      if (doc.y + 65 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      doc.fontSize(12).fillColor('#164d40').text('相关链接', { width });
      doc.moveDown(0.4).fontSize(10.2);
      for (const link of links) doc.fillColor('#202c28').text(`${link.label}  ${link.url}`,
        { width, lineGap: 4, paragraphGap: 5, link: link.url });
    }
    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      doc.switchToPage(index);
      // PDFKit's text flow otherwise moves a footer below the content margin to a new blank page.
      const contentBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor('#65716c').text(String(index + 1), 52, doc.page.height - 30,
        { width, align: 'right', lineBreak: false });
      doc.page.margins.bottom = contentBottom;
    }
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return completed;
}

export async function resumeDocx(profile, { photo: sourcePhoto } = {}) {
  const font = { ascii: 'FandolHei', hAnsi: 'FandolHei', eastAsia: 'FandolHei' };
  const header = [new Paragraph({ text: profile.name, heading: HeadingLevel.TITLE,
    spacing: { after: 140 }, keepNext: true })];
  const subtitle = [profile.title, profile.major].filter(Boolean).join(' / ');
  if (subtitle) header.push(new Paragraph({ text: subtitle, spacing: { after: 100 }, keepNext: true }));
  if (profile.publicEmail) header.push(new Paragraph({ children: [new ExternalHyperlink({
    link: `mailto:${profile.publicEmail}`, children: [new TextRun({ text: profile.publicEmail, style: 'Hyperlink' })]
  })], spacing: { after: 160 } }));
  const photo = resumePhoto(sourcePhoto);
  const children = [...header];
  if (photo) {
    const border = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const margins = { top: 0, bottom: 0, left: 0, right: 0 };
    children.splice(0, children.length, new Table({
      width: { size: 9826, type: WidthType.DXA }, columnWidths: [7906, 1920], layout: TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: [new TableRow({ cantSplit: true, children: [
        new TableCell({ width: { size: 7906, type: WidthType.DXA }, margins: { ...margins, right: 240 },
          verticalAlign: VerticalAlign.TOP, children: header }),
        new TableCell({ width: { size: 1920, type: WidthType.DXA }, margins, verticalAlign: VerticalAlign.TOP,
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 160 },
            children: [new ImageRun({ type: photo.type, data: photo.data, transformation: fitPhoto(photo, 96, 128),
              altText: { name: '生活照', title: '生活照', description: `${profile.name}的生活照` } })] })] })
      ] })]
    }));
  }
  for (const [key, label] of resumeSections) {
    if (!profile[key]?.trim()) continue;
    children.push(new Paragraph({ text: label, heading: HeadingLevel.HEADING_1, keepNext: true,
      spacing: { before: 200, after: 80 } }));
    for (const line of profile[key].split(/\r?\n/)) {
      children.push(new Paragraph({ text: line, spacing: { after: 60, line: 280 }, widowControl: true }));
    }
  }
  const links = publicLinks(profile.links);
  if (links.length) {
    children.push(new Paragraph({ text: '相关链接', heading: HeadingLevel.HEADING_1, keepNext: true,
      spacing: { before: 200, after: 80 } }));
    for (const [index, link] of links.entries()) children.push(new Paragraph({ children: [new ExternalHyperlink({
      link: link.url, children: [new TextRun({ text: `${link.label}  ${link.url}`, style: 'Hyperlink' })]
    })], spacing: { after: 70 }, keepNext: index < links.length - 1 }));
  }
  return Packer.toBuffer(new Document({ creator: profile.name, title: `${profile.name}的个人简历`,
    fonts: [{ name: 'FandolHei', data: readFileSync(bundledFont) }],
    styles: { default: { document: { run: { font, size: 21, color: '202C28' },
      paragraph: { spacing: { line: 280 } } }, title: { run: { font, size: 44, bold: true, color: '000000' } },
    heading1: { run: { font, size: 25, bold: true, color: '000000' } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 },
      margin: { top: 1000, right: 1040, bottom: 1000, left: 1040 } } }, children }]
  }));
}
