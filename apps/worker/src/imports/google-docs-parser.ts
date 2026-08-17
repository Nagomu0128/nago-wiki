export interface GoogleDocsConversion {
  title: string;
  markdown: string;
  inlineObjectIds: string[];
  warnings: string[];
}

export function googleDocumentToMarkdown(document: unknown): GoogleDocsConversion {
  const root = asRecord(document);
  const title = stringField(root, "title") ?? "Imported Google Document";
  const inlineObjectIds = new Set<string>();
  const warnings: string[] = [];
  const body = asRecord(root?.body);
  const content = asArray(body?.content);
  const blocks = content.flatMap((element) =>
    convertStructuralElement(element, inlineObjectIds, warnings),
  );

  return {
    title,
    markdown: blocks.join("\n\n").replace(/\n{3,}/gu, "\n\n").trimEnd() + "\n",
    inlineObjectIds: [...inlineObjectIds],
    warnings,
  };
}

function convertStructuralElement(
  value: unknown,
  inlineObjectIds: Set<string>,
  warnings: string[],
): string[] {
  const element = asRecord(value);
  if (element === null) return [];
  const paragraph = asRecord(element.paragraph);
  if (paragraph !== null) {
    return [convertParagraph(paragraph, inlineObjectIds)];
  }
  const table = asRecord(element.table);
  if (table !== null) {
    return [convertTable(table, inlineObjectIds, warnings)];
  }
  if (element.sectionBreak !== undefined) return [];
  warnings.push("Unsupported Google Docs structural element was skipped.");
  return [];
}

function convertParagraph(paragraph: Record<string, unknown>, inlineObjectIds: Set<string>): string {
  const text = asArray(paragraph.elements)
    .map((element) => convertParagraphElement(element, inlineObjectIds))
    .join("")
    .replace(/\n$/u, "");
  const style = asRecord(paragraph.paragraphStyle);
  const namedStyle = stringField(style, "namedStyleType");
  const heading = /^HEADING_([1-6])$/u.exec(namedStyle ?? "");
  if (heading?.[1] !== undefined) {
    return `${"#".repeat(Number(heading[1]))} ${text}`;
  }
  const bullet = asRecord(paragraph.bullet);
  if (bullet !== null) {
    const nestingLevel = numberField(bullet, "nestingLevel") ?? 0;
    return `${"  ".repeat(Math.max(0, nestingLevel))}- ${text}`;
  }
  return text;
}

function convertParagraphElement(value: unknown, inlineObjectIds: Set<string>): string {
  const element = asRecord(value);
  if (element === null) return "";
  const textRun = asRecord(element.textRun);
  if (textRun !== null) {
    const content = stringField(textRun, "content") ?? "";
    const style = asRecord(textRun.textStyle);
    return applyTextStyle(content, style);
  }
  const inlineObject = asRecord(element.inlineObjectElement);
  const objectId = stringField(inlineObject, "inlineObjectId");
  if (objectId !== null) {
    inlineObjectIds.add(objectId);
    return `![Google Docs image](google-inline-object:${objectId})`;
  }
  const pageBreak = asRecord(element.pageBreak);
  return pageBreak === null ? "" : "\n\n---\n\n";
}

function applyTextStyle(content: string, style: Record<string, unknown> | null): string {
  if (content === "\n" || content.length === 0) return content;
  const trailingNewline = content.endsWith("\n") ? "\n" : "";
  let rendered = escapeMarkdown(content.replace(/\n$/u, ""));
  if (style?.bold === true) rendered = `**${rendered}**`;
  if (style?.italic === true) rendered = `_${rendered}_`;
  if (style?.strikethrough === true) rendered = `~~${rendered}~~`;
  const link = asRecord(style?.link);
  const url = stringField(link, "url");
  if (url !== null && isHttpUrl(url)) rendered = `[${rendered}](${url})`;
  return rendered + trailingNewline;
}

function convertTable(
  table: Record<string, unknown>,
  inlineObjectIds: Set<string>,
  warnings: string[],
): string {
  const rows = asArray(table.tableRows).map((row) => {
    const cells = asArray(asRecord(row)?.tableCells);
    return cells.map((cell) => {
      const cellRecord = asRecord(cell);
      return asArray(cellRecord?.content)
        .flatMap((element) => convertStructuralElement(element, inlineObjectIds, warnings))
        .join(" ")
        .replaceAll("|", "\\|")
        .replace(/\s+/gu, " ")
        .trim();
    });
  });
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const header = normalized[0] ?? [];
  return [
    tableRow(header),
    tableRow(header.map(() => "---")),
    ...normalized.slice(1).map(tableRow),
  ].join("\n");
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(
  value: Record<string, unknown> | null,
  field: string,
): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" ? candidate : null;
}

function numberField(
  value: Record<string, unknown> | null,
  field: string,
): number | null {
  const candidate = value?.[field];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
