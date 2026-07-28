import assert from "node:assert/strict";
import test from "node:test";

import { SafeWhatsAppError, publicError } from "../dist/errors.js";

test("public errors preserve safe messages and codes", () => {
  const error = new SafeWhatsAppError("Pairing is required.", "not_paired");
  assert.deepEqual(publicError(error), {
    code: "not_paired",
    message: "Pairing is required.",
  });
});

test("unexpected errors are redacted", () => {
  assert.deepEqual(publicError(new Error("secret path")), {
    code: "internal_error",
    message: "Safe WhatsApp MCP could not complete the request.",
  });
});

