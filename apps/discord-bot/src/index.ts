export function normalizeMentionQuery(content: string, botUserId: string): string {
  return content.replaceAll(`<@${botUserId}>`, "").trim();
}
