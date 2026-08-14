/**
 * Pins the TS port (core webhook path) to the vendored action extractor — the two MUST stay in
 * sync (see the KEEP IN SYNC headers in both files). Any drift fails here before it ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSurfaces, isContractSurface } from "./surface-extract.js";

// @ts-ignore — vendored dependency-free .mjs, no type declarations by design
const action = (await import("../../../../actions/pr-check/surface.mjs")) as {
  extractSurfaces: (path: string, content: string) => string[];
  isContractSurface: (path: string) => boolean;
};

const FIXTURES: Array<{ path: string; content: string }> = [
  {
    path: "src/routes/auth.ts",
    content: `import express from "express";
const router = express.Router();
router.post("/auth/session", handler);
router.get("/auth/session/:id", handler);
app.all("/health/", handler);
router.put("users/{userId}/profile?x=1", handler);`,
  },
  {
    path: "app/api/orders/[id]/route.ts",
    content: `export async function GET(req) {}
export function DELETE(req) {}`,
  },
  {
    path: "protos/auth.proto",
    content: `package auth.v1;
service Auth {
  rpc Login (LoginRequest) returns (LoginResponse);
  rpc Logout (LogoutRequest) returns (LogoutResponse);
}`,
  },
  {
    path: "schema/schema.graphql",
    content: `type Query {
  order(id: ID!): Order
  orders: [Order]
}
extend type Mutation {
  createOrder(input: OrderInput!): Order
}`,
  },
  { path: "src/lib/util.ts", content: `export const add = (a, b) => a + b;` },
  { path: "src/controllers/payments.js", content: `app.patch("/payments/:id", fn);` },
];

test("extractSurfaces: TS port ≡ vendored action on shared fixtures", () => {
  for (const f of FIXTURES) {
    assert.deepEqual(
      extractSurfaces(f.path, f.content).sort(),
      action.extractSurfaces(f.path, f.content).sort(),
      `drift on ${f.path}`,
    );
  }
  // Sanity: the fixtures actually exercise every extractor family.
  assert.deepEqual(extractSurfaces(FIXTURES[0]!.path, FIXTURES[0]!.content).sort(), [
    "http:ANY /health",
    "http:GET /auth/session/:id",
    "http:POST /auth/session",
    "http:PUT /users/:userId/profile",
  ]);
  assert.deepEqual(extractSurfaces(FIXTURES[2]!.path, FIXTURES[2]!.content).sort(), [
    "proto:auth.v1.Auth/Login",
    "proto:auth.v1.Auth/Logout",
  ]);
});

test("isContractSurface: TS port ≡ vendored action", () => {
  const paths = [
    "src/routes/auth.ts",
    "openapi.yaml",
    "docs/swagger.json",
    "protos/auth.proto",
    "schema.graphql",
    "src/lib/util.ts",
    "README.md",
    "src/api/index.ts",
  ];
  for (const p of paths) assert.equal(isContractSurface(p), action.isContractSurface(p), `drift on ${p}`);
});
