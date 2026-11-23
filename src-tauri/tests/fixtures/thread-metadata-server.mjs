#!/usr/bin/env node
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.4"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const threads = ["parent", "child", "archived"].map(id => ({ id, name: id, createdAt: 1, updatedAt: 1, cwd: "/project", preview: "", archived: id === "archived" }));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params: p } = JSON.parse(line);
  switch (method) {
    case "initialize": send({ id, result: {} }); break;
    case "initialized": break;
    case "thread/name/set":
      assert.equal(p.threadId, "parent"); assert.equal(p.name, p.name.trim());
      if (p.name === "fail") { send({ id, error: { message: "rename rejected" } }); break; }
      threads[0].name = p.name;
      send({ id, result: {} }); break;
    case "thread/archive":
      assert.equal(p.threadId, "parent"); threads[0].archived = threads[1].archived = true;
      send({ method: "thread/archived", params: { threadId: "child" } });
      send({ id, result: {} }); break;
    case "thread/unarchive":
      assert.equal(p.threadId, "archived"); threads[2].archived = false;
      send({ id, result: { thread: threads[2] } }); break;
    case "thread/list": {
      assert.equal(p.useStateDbOnly, true);
      const matching = threads.filter(thread => thread.archived === p.archived);
      const index = p.cursor ? Number(p.cursor) : 0;
      send({ id, result: { data: matching.slice(index, index + 1), nextCursor: index + 1 < matching.length ? String(index + 1) : null } }); break;
    }
    default: throw new Error(`Unexpected operation: ${method}`);
  }
}
