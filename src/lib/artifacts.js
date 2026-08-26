import { createRequire } from "node:module";
import PptxGenJS from "pptxgenjs";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const require = createRequire(import.meta.url);

const FORMAT_CONFIG = {
  pptx: {
    extension: ".pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  docx: {
    extension: ".docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    extension: ".xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pdf: { extension: ".pdf", contentType: "application/pdf" },
};

function stringValue(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function stringArray(value, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeTable(value) {
  const headers = stringArray(value?.headers, 20);
  const rows = Array.isArray(value?.rows)
    ? value.rows.slice(0, 200).map((row) =>
        Array.isArray(row)
          ? row.slice(0, Math.max(1, headers.length || 20)).map((cell) => String(cell ?? ""))
          : [String(row ?? "")],
      )
    : [];
  return { headers, rows };
}

function worksheetName(value, fallback) {
  const cleaned = stringValue(value, fallback)
    .replace(/[\\/*?:\[\]]/g, "_")
    .replace(/^'+|'+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 31);
}

function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => ({
      title: stringValue(item?.title, "参照元"),
      url: stringValue(item?.url),
    }))
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .slice(0, 30);
}

export function normalizeArtifactSpec(value) {
  const sections = Array.isArray(value?.sections)
    ? value.sections.slice(0, 30).map((section, index) => ({
        title: stringValue(section?.title, `セクション ${index + 1}`),
        paragraphs: stringArray(section?.paragraphs, 20),
        bullets: stringArray(section?.bullets, 30),
        table: normalizeTable(section?.table),
      }))
    : [];
  const worksheets = Array.isArray(value?.worksheets)
    ? value.worksheets.slice(0, 20).map((sheet, index) => ({
        name: worksheetName(sheet?.name, `Sheet${index + 1}`),
        rows: Array.isArray(sheet?.rows)
          ? sheet.rows.slice(0, 2000).map((row) =>
              Array.isArray(row)
                ? row.slice(0, 100).map((cell) => String(cell ?? ""))
                : [String(row ?? "")],
            )
          : [],
      }))
    : [];

  return {
    title: stringValue(value?.title, "生成資料"),
    subtitle: stringValue(value?.subtitle),
    summary: stringValue(value?.summary),
    sections,
    worksheets,
  };
}

function addPptxSourceNotes(slide, sources) {
  if (sources.length === 0) return;
  slide.addNotes(`[Sources]\n${sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`);
}

function makePptx(spec, sources) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Internal GPT-5.6 Assistant";
  pptx.subject = spec.summary || spec.title;
  pptx.title = spec.title;
  pptx.company = "Internal";
  pptx.lang = "ja-JP";
  pptx.theme = {
    headFontFace: "Yu Gothic",
    bodyFontFace: "Yu Gothic",
    lang: "ja-JP",
  };

  const cover = pptx.addSlide();
  cover.background = { color: "F1F5F9" };
  cover.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.22,
    fill: { color: "0E7490" },
    line: { color: "0E7490" },
  });
  cover.addText(spec.title, {
    x: 0.8,
    y: 1.95,
    w: 11.7,
    h: 1.75,
    fontFace: "Yu Gothic",
    fontSize: 50,
    bold: true,
    color: "0F172A",
    margin: 0,
    breakLine: false,
  });
  if (spec.subtitle || spec.summary) {
    cover.addText(spec.subtitle || spec.summary, {
      x: 0.82,
      y: 3.75,
      w: 10.8,
      h: 1.1,
      fontFace: "Yu Gothic",
      fontSize: 16,
      color: "475569",
      margin: 0,
    });
  }
  addPptxSourceNotes(cover, sources);

  const sections = spec.sections.length
    ? spec.sections
    : [{ title: "概要", paragraphs: [spec.summary], bullets: [], table: { headers: [], rows: [] } }];
  for (const section of sections.slice(0, 20)) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(section.title.slice(0, 24), {
      x: 0.65,
      y: 0.42,
      w: 12,
      h: 0.72,
      fontFace: "Yu Gothic",
      fontSize: 35,
      bold: true,
      color: "0F172A",
      margin: 0,
      breakLine: false,
      fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.line, {
      x: 0.65,
      y: 1.12,
      w: 12,
      h: 0,
      line: { color: "06B6D4", width: 2 },
    });
    const lines = [
      ...section.paragraphs,
      ...section.bullets.map((item) => `• ${item}`),
    ].filter(Boolean);
    slide.addText(lines.join("\n"), {
      x: 0.78,
      y: 1.45,
      w: 11.75,
      h: 5.45,
      fontFace: "Yu Gothic",
      fontSize: 17,
      color: "1E293B",
      breakLine: false,
      valign: "top",
      margin: 0.08,
      paraSpaceAfterPt: 10,
      fit: "shrink",
    });
    addPptxSourceNotes(slide, sources);

    const table = section.table;
    const allRows = [table.headers, ...table.rows].filter((row) => row.length > 0);
    const chunks = [];
    for (let index = 0; index < allRows.length; index += 7) {
      const chunkRows = allRows.slice(index, index + 7);
      if (index > 0 && table.headers.length) chunkRows.unshift(table.headers);
      chunks.push(chunkRows);
    }
    chunks.forEach((chunk, chunkIndex) => {
      const tableSlide = pptx.addSlide();
      tableSlide.background = { color: "FFFFFF" };
      const suffix = chunks.length > 1 ? `（${chunkIndex + 1}/${chunks.length}）` : "";
      const styledRows = chunk.map((row, rowIndex) =>
        row.map((cell) =>
          rowIndex === 0
            ? {
                text: String(cell),
                options: { bold: true, color: "FFFFFF", fill: "0E7490" },
              }
            : String(cell),
        ),
      );
      tableSlide.addTable(styledRows, {
        x: 0.75,
        y: 1.52,
        w: 11.8,
        fontFace: "Yu Gothic",
        fontSize: 14,
        color: "1E293B",
        border: { type: "solid", color: "CBD5E1", pt: 1 },
        fill: "FFFFFF",
        margin: 0.08,
        autoFit: false,
        bold: false,
        valign: "middle",
        rowH: 0.5,
      });
      tableSlide.addText(section.title.slice(0, 18), {
        x: 0.65,
        y: 0.42,
        w: 10.4,
        h: 0.72,
        fontFace: "Yu Gothic",
        fontSize: 35,
        bold: true,
        color: "0F172A",
        margin: 0,
        breakLine: false,
        fit: "shrink",
      });
      if (suffix) {
        tableSlide.addText(suffix, {
          x: 11.15,
          y: 0.48,
          w: 1.5,
          h: 0.55,
          fontFace: "Yu Gothic",
          fontSize: 20,
          color: "475569",
          align: "right",
          margin: 0,
        });
      }
      tableSlide.addShape(pptx.ShapeType.line, {
        x: 0.65,
        y: 1.2,
        w: 12,
        h: 0,
        line: { color: "06B6D4", width: 2 },
      });
      addPptxSourceNotes(tableSlide, sources);
    });
  }

  return pptx.write({ outputType: "nodebuffer" });
}

function paragraphChildren(section) {
  const children = [
    new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }),
  ];
  for (const text of section.paragraphs) {
    children.push(new Paragraph({ children: [new TextRun(text)] }));
  }
  for (const text of section.bullets) {
    children.push(
      new Paragraph({ children: [new TextRun(text)], bullet: { level: 0 } }),
    );
  }
  if (section.table.headers.length || section.table.rows.length) {
    const rows = [];
    if (section.table.headers.length) {
      rows.push(
        new TableRow({
          children: section.table.headers.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })],
              }),
          ),
        }),
      );
    }
    for (const row of section.table.rows) {
      rows.push(
        new TableRow({
          children: row.map(
            (cell) => new TableCell({ children: [new Paragraph(String(cell))] }),
          ),
        }),
      );
    }
    if (rows.length) {
      children.push(
        new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
      );
    }
  }
  return children;
}

async function makeDocx(spec, sources) {
  const children = [
    new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE }),
  ];
  if (spec.subtitle) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true })] }),
    );
  }
  if (spec.summary) {
    children.push(new Paragraph({ children: [new TextRun(spec.summary)] }));
  }
  for (const section of spec.sections) {
    children.push(...paragraphChildren(section));
  }
  if (sources.length > 0) {
    children.push(new Paragraph({ text: "参照元", heading: HeadingLevel.HEADING_1 }));
    for (const source of sources) {
      children.push(new Paragraph({ text: `${source.title}: ${source.url}` }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Yu Gothic", size: 22 } },
      },
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

async function makeXlsx(spec, sources) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Internal GPT-5.6 Assistant";
  workbook.created = new Date();
  const worksheets = spec.worksheets.length
    ? spec.worksheets
    : [
        {
          name: "概要",
          rows: [
            ["タイトル", spec.title],
            ["要約", spec.summary],
            ...spec.sections.map((section) => [section.title, [...section.paragraphs, ...section.bullets].join("\n")]),
          ],
        },
      ];

  const usedSheetNames = new Set();
  for (const [sheetIndex, item] of worksheets.entries()) {
    const baseName = worksheetName(item.name, `Sheet${sheetIndex + 1}`);
    let candidate = baseName;
    let suffix = 2;
    while (usedSheetNames.has(candidate.toLowerCase())) {
      const marker = ` (${suffix})`;
      candidate = `${baseName.slice(0, 31 - marker.length)}${marker}`;
      suffix += 1;
    }
    usedSheetNames.add(candidate.toLowerCase());
    const sheet = workbook.addWorksheet(candidate);
    item.rows.forEach((row) => sheet.addRow(row));
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7490" } };
    header.alignment = { vertical: "middle", wrapText: true };
    sheet.eachRow((row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
    sheet.columns.forEach((column) => {
      let width = 12;
      column.eachCell({ includeEmpty: true }, (cell) => {
        width = Math.min(50, Math.max(width, String(cell.value ?? "").length + 2));
      });
      column.width = width;
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  if (sources.length > 0) {
    let sourceSheetName = "Sources";
    let suffix = 2;
    while (usedSheetNames.has(sourceSheetName.toLowerCase())) {
      sourceSheetName = `Sources (${suffix})`;
      suffix += 1;
    }
    const sourceSheet = workbook.addWorksheet(sourceSheetName);
    sourceSheet.addRow(["タイトル", "URL"]);
    sources.forEach((source) => sourceSheet.addRow([source.title, source.url]));
    sourceSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sourceSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7490" } };
    sourceSheet.columns = [{ width: 32 }, { width: 80 }];
    sourceSheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function resolvePdfFont() {
  return require.resolve(
    "noto-fontface-cjk-jp/fonts/Noto/NotoSansCJKjp-Regular.otf",
  );
}

function makePdf(spec, sources) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 54, left: 54, right: 54 } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.font(resolvePdfFont());
    doc.fontSize(22).fillColor("#0f172a").text(spec.title);
    if (spec.subtitle) {
      doc.moveDown(0.4).fontSize(12).fillColor("#475569").text(spec.subtitle);
    }
    if (spec.summary) {
      doc.moveDown().fontSize(11).fillColor("#1e293b").text(spec.summary, { lineGap: 4 });
    }
    for (const section of spec.sections) {
      doc.moveDown(1.2).fontSize(16).fillColor("#0e7490").text(section.title);
      for (const paragraph of section.paragraphs) {
        doc.moveDown(0.45).fontSize(10.5).fillColor("#1e293b").text(paragraph, { lineGap: 3 });
      }
      for (const bullet of section.bullets) {
        doc.moveDown(0.25).fontSize(10.5).fillColor("#1e293b").text(`• ${bullet}`, {
          indent: 12,
          lineGap: 3,
        });
      }
      const table = section.table;
      if (table.headers.length) {
        doc.moveDown(0.6).fontSize(9).fillColor("#0f172a").text(table.headers.join("  |  "));
      }
      for (const row of table.rows.slice(0, 40)) {
        doc.moveDown(0.15).fontSize(8.5).fillColor("#334155").text(row.join("  |  "));
      }
    }
    if (sources.length > 0) {
      doc.moveDown(1.2).fontSize(16).fillColor("#0e7490").text("参照元");
      for (const source of sources) {
        doc.moveDown(0.25).fontSize(9).fillColor("#334155").text(`${source.title}: ${source.url}`);
      }
    }
    doc.end();
  });
}

export async function buildArtifact(format, rawSpec, options = {}) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  const formatConfig = FORMAT_CONFIG[normalizedFormat];
  if (!formatConfig) {
    throw new Error("Unsupported artifact format.");
  }
  const spec = normalizeArtifactSpec(rawSpec);
  const sources = normalizeSources(options.sources);
  let buffer;
  if (normalizedFormat === "pptx") buffer = await makePptx(spec, sources);
  else if (normalizedFormat === "docx") buffer = await makeDocx(spec, sources);
  else if (normalizedFormat === "xlsx") buffer = await makeXlsx(spec, sources);
  else buffer = await makePdf(spec, sources);

  return {
    ...formatConfig,
    format: normalizedFormat,
    spec,
    buffer: Buffer.from(buffer),
  };
}
