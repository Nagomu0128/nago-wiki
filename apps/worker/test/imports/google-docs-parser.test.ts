import { describe, expect, it } from "vitest";

import { googleDocumentToMarkdown } from "../../src/imports/google-docs-parser";

describe("googleDocumentToMarkdown", () => {
  it("converts headings, styled text, lists, images, and tables", () => {
    const result = googleDocumentToMarkdown({
      title: "Knowledge",
      body: {
        content: [
          paragraph("Overview\n", { namedStyleType: "HEADING_1" }),
          {
            paragraph: {
              elements: [
                { textRun: { content: "bold", textStyle: { bold: true } } },
                { textRun: { content: " and ", textStyle: {} } },
                {
                  textRun: {
                    content: "link\n",
                    textStyle: { link: { url: "https://example.com" } },
                  },
                },
              ],
            },
          },
          { paragraph: { bullet: { nestingLevel: 1 }, elements: text("Item\n") } },
          {
            paragraph: {
              elements: [{ inlineObjectElement: { inlineObjectId: "image-1" } }],
            },
          },
          {
            table: {
              tableRows: [
                { tableCells: [cell("Name\n"), cell("Value\n")] },
                { tableCells: [cell("A\n"), cell("B\n")] },
              ],
            },
          },
        ],
      },
    });

    expect(result.title).toBe("Knowledge");
    expect(result.markdown).toContain("# Overview");
    expect(result.markdown).toContain("**bold** and [link](https://example.com)");
    expect(result.markdown).toContain("  - Item");
    expect(result.markdown).toContain(
      "![Google Docs image](google-inline-object:image-1)",
    );
    expect(result.markdown).toContain("| Name | Value |");
    expect(result.inlineObjectIds).toEqual(["image-1"]);
  });

  it("skips unknown structures and reports a warning", () => {
    const result = googleDocumentToMarkdown({ body: { content: [{ unknown: true }] } });
    expect(result.warnings).toHaveLength(1);
  });
});

function paragraph(content: string, paragraphStyle: Record<string, unknown>) {
  return { paragraph: { paragraphStyle, elements: text(content) } };
}

function text(content: string) {
  return [{ textRun: { content, textStyle: {} } }];
}

function cell(content: string) {
  return { content: [{ paragraph: { elements: text(content) } }] };
}
