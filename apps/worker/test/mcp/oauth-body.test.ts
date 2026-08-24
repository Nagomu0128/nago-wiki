import { describe, expect, it } from "vitest";

import { readAuthorizeForm } from "../../src/mcp/oauth";

describe("public OAuth authorize body bounds", () => {
  it("parses the expected small urlencoded consent form", async () => {
    const request = new Request("https://wiki.example/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "flow_id=one&csrf_token=two&action=approve",
    });
    const form = await readAuthorizeForm(request);
    expect(form.get("flow_id")).toBe("one");
  });

  it("rejects a large body before form parsing", async () => {
    const request = new Request("https://wiki.example/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "9000",
      },
      body: "action=approve",
    });
    await expect(readAuthorizeForm(request)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects multipart bodies instead of invoking unbounded formData", async () => {
    const request = new Request("https://wiki.example/authorize", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x--",
    });
    await expect(readAuthorizeForm(request)).rejects.toMatchObject({ status: 415 });
  });
});
