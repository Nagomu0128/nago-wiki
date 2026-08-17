import * as Y from "yjs";

export const localMarkdownOrigin = Symbol("nago-local-markdown");

export function replaceSharedMarkdown(
  document: Y.Doc,
  markdown: string,
  origin: unknown = localMarkdownOrigin,
): boolean {
  const shared = document.getText("markdown");
  const current = shared.toJSON();
  if (current === markdown) return false;

  let prefix = 0;
  const sharedLength = Math.min(current.length, markdown.length);
  while (prefix < sharedLength && current[prefix] === markdown[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < markdown.length - prefix &&
    current[current.length - suffix - 1] === markdown[markdown.length - suffix - 1]
  ) {
    suffix += 1;
  }

  document.transact(() => {
    const deleteLength = current.length - prefix - suffix;
    if (deleteLength > 0) shared.delete(prefix, deleteLength);
    const insertion = markdown.slice(prefix, markdown.length - suffix);
    if (insertion.length > 0) shared.insert(prefix, insertion);
  }, origin);
  return true;
}
