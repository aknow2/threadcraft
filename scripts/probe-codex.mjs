import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Metadata only: never print thread titles, IDs, paths, or server stderr.
async function inventory() {
  const child = spawn(
    process.env.TREADCRAFT_CODEX_BIN || "codex",
    ["app-server", "--listen", "stdio://"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const fail = () => {
    for (const { reject } of pending.values())
      reject(new Error("Codex process unavailable"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  lines.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.error) job.reject(new Error(`RPC failed (${msg.error.code})`));
      else job.resolve(msg.result);
    } catch {
      fail();
    }
  });
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("RPC timeout"));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  };
  try {
    await request("initialize", {
      clientInfo: { name: "treadcraft_probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    let modelCheck;
    if (process.argv.includes("--models")) {
      const models = [];
      const seen = new Set();
      let cursor = null;
      do {
        const page = await request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        });
        if (!Array.isArray(page.data)) throw new Error("Invalid model catalog");
        models.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 100))
          throw new Error("Invalid model cursor");
        seen.add(cursor);
      } while (cursor);
      modelCheck = {
        count: models.length,
        valid: models.every(
          (m) =>
            typeof m.model === "string" &&
            typeof m.displayName === "string" &&
            typeof m.isDefault === "boolean" &&
            typeof m.defaultReasoningEffort === "string" &&
            Array.isArray(m.supportedReasoningEfforts) &&
            m.supportedReasoningEfforts.every(
              (e) =>
                typeof e.reasoningEffort === "string" &&
                typeof e.description === "string",
            ) &&
            (!m.supportedReasoningEfforts.length ||
              m.supportedReasoningEfforts.some(
                (e) => e.reasoningEffort === m.defaultReasoningEffort,
              )),
        ),
      };
    }
    const ids = new Set();
    const cursors = new Set();
    let cursor = null;
    let pages = 0;
    let metadataValid = true;
    let workspaceFound = false;
    let sampleThread = null;
    do {
      const page = await request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "created_at",
        sortDirection: "desc",
        archived: false,
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        useStateDbOnly: true,
      });
      if (!Array.isArray(page.data)) throw new Error("Invalid page");
      pages++;
      for (const thread of page.data) {
        ids.add(thread.id);
        metadataValid &&=
          typeof thread.id === "string" && Number.isFinite(thread.createdAt);
        workspaceFound ||= thread.cwd === process.cwd();
        if (!sampleThread && thread.cwd === process.cwd())
          sampleThread = thread.id;
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated cursor");
      cursors.add(cursor);
      if (pages > 1000) throw new Error("Page limit exceeded");
    } while (cursor);
    let chatCheck;
    if (process.argv.includes("--chat") && sampleThread) {
      const first = await request("thread/items/list", {
        threadId: sampleThread,
        limit: 2,
        sortDirection: "asc",
      });
      const next = first.nextCursor
        ? await request("thread/items/list", {
            threadId: sampleThread,
            cursor: first.nextCursor,
            limit: 2,
            sortDirection: "asc",
          })
        : null;
      chatCheck = {
        firstPage: first.data.length,
        secondPage: next?.data.length ?? 0,
        validEntries: first.data.every(
          (entry) =>
            typeof entry.turnId === "string" &&
            typeof entry.item?.type === "string",
        ),
        hasMessages: first.data.some((entry) =>
          ["userMessage", "agentMessage"].includes(entry.item?.type),
        ),
      };
    }
    return { ids, pages, metadataValid, workspaceFound, chatCheck, modelCheck };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(force);
  }
}

try {
  const a = await inventory();
  const b = await inventory();
  console.log(
    JSON.stringify({
      count: a.ids.size,
      pages: a.pages,
      metadataValid: a.metadataValid,
      currentWorkspaceFound: a.workspaceFound,
      stableIdsAcrossReconnect: [...a.ids].every((id) => b.ids.has(id)),
      secondCount: b.ids.size,
      chatCheck: a.chatCheck,
      modelCheck: a.modelCheck,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
