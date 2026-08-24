export interface GoogleDocsConversion {
  title: string;
  markdown: string;
  inlineObjectIds: string[];
  inlineImages: GoogleDocsInlineImage[];
  warnings: string[];
}

export interface GoogleDocsInlineImage {
  objectId: string;
  contentUri: string;
  altText: string;
}

export function googleDocumentToMarkdown(document: unknown): GoogleDocsConversion {
  const root = asRecord(document);
  const title = stringField(root, "title") ?? "Imported Google Document";
  const inlineObjectIds = new Set<string>();
  const warnings: string[] = [];
  const tabs = collectDocumentTabs(root);
  const sections = tabs.length === 0
    ? [convertDocumentSection(root, null, 0, false, inlineObjectIds, warnings)]
    : tabs.map(({ documentTab, title: tabTitle, depth }) =>
        convertDocumentSection(
          documentTab,
          tabTitle,
          depth,
          tabs.length > 1,
          inlineObjectIds,
          warnings,
        ));
  const inlineObjects = collectInlineObjects(root, tabs);
  const inlineImages = [...inlineObjectIds].flatMap((objectId) => {
    const image = googleInlineImage(inlineObjects[objectId], objectId);
    if (image === null) {
      warnings.push(`Google Docs image ${objectId} could not be read and was skipped.`);
      return [];
    }
    return [image];
  });

  return {
    title,
    markdown: sections.filter(Boolean).join("\n\n").replace(/\n{3,}/gu, "\n\n").trimEnd() + "\n",
    inlineObjectIds: [...inlineObjectIds],
    inlineImages,
    warnings,
  };
}

interface DocumentTabContent {
  documentTab: Record<string, unknown>;
  title: string;
  depth: number;
}

function collectDocumentTabs(root: Record<string, unknown> | null): DocumentTabContent[] {
  const result: DocumentTabContent[] = [];
  const visit = (value: unknown, depth: number): void => {
    const tab = asRecord(value);
    const documentTab = asRecord(tab?.documentTab);
    if (documentTab !== null) {
      const properties = asRecord(tab?.tabProperties);
      result.push({
        documentTab,
        title: stringField(properties, "title") ?? `Tab ${String(result.length + 1)}`,
        depth,
      });
    }
    for (const child of asArray(tab?.childTabs)) visit(child, depth + 1);
  };
  for (const tab of asArray(root?.tabs)) visit(tab, 0);
  return result;
}

function convertDocumentSection(
  value: Record<string, unknown> | null,
  title: string | null,
  depth: number,
  includeTitle: boolean,
  inlineObjectIds: Set<string>,
  warnings: string[],
): string {
  const body = asRecord(value?.body);
  const blocks = asArray(body?.content).flatMap((element) =>
    convertStructuralElement(element, inlineObjectIds, warnings));
  if (includeTitle && title !== null) {
    blocks.unshift(`${"#".repeat(Math.min(6, depth + 2))} ${escapeMarkdown(title)}`);
  }
  return blocks.join("\n\n");
}

function collectInlineObjects(
  root: Record<string, unknown> | null,
  tabs: DocumentTabContent[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(asRecord(root?.inlineObjects) ?? {}) };
  for (const { documentTab } of tabs) {
    Object.assign(result, asRecord(documentTab.inlineObjects) ?? {});
  }
  return result;
}

function googleInlineImage(value: unknown, objectId: string): GoogleDocsInlineImage | null {
  const object = asRecord(value);
  const properties = asRecord(object?.inlineObjectProperties);
  const embedded = asRecord(properties?.embeddedObject);
  const image = asRecord(embedded?.imageProperties);
  const contentUri = stringField(image, "contentUri");
  if (contentUri === null || !isHttpsUrl(contentUri)) return null;
  const title = stringField(embedded, "title")?.trim();
  const description = stringField(embedded, "description")?.trim();
  return {
    objectId,
    contentUri,
    altText: [title, description].filter((part) => part !== undefined && part.length > 0).join(" — ")
      || "Google Docs image",
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
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
