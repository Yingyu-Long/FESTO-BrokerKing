import test from "node:test";
import assert from "node:assert/strict";
import { FestoClient, collectRepairs, loginAccount } from "../lib/festo/client.ts";
import { dateBounds, formatTime, csvCell, toCsv, validateFilters } from "../lib/festo/shared.ts";
import { checkRequest, readBody } from "../lib/festo/http.ts";
import type { Machine } from "../lib/festo/types.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const machine: Machine = { id: id(1), name: "装配线一号", number: "001" };
const page = (items: unknown[], offset = 0, total = items.length) =>
  Response.json({ items, count: items.length, offset, total });
const filters = {
  machineIds: [machine.id],
  from: "2026-09-01",
  to: "2026-09-08",
};
const fetchMock = (fn: (url: URL, init?: RequestInit) => Promise<Response> | Response) =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      fn(new URL(input instanceof Request ? input.url : String(input)), init),
    )) as typeof fetch;

void test("北京时间日期边界：含起止全天，不包含次日零点", () => {
  const b = dateBounds("2026-09-01", "2026-09-08");
  assert.equal(new Date(b.start).toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(new Date(b.end).toISOString(), "2026-09-08T16:00:00.000Z");
  assert.equal(formatTime("2026-09-08T15:59:59Z"), "2026-09-08 23:59:59");
  assert.throws(() => dateBounds("2026-02-30", "2026-03-01"));
  assert.throws(() => dateBounds("2026-09-09", "2026-09-08"));
  assert.throws(() => validateFilters({ ...filters, machineIds: ["../bad"] }));
  assert.deepEqual(validateFilters({ ...filters, machineIds: [id(1), id(1)] }).machineIds, [id(1)]);
});
void test("分页读取全部故障，即使单页数量小于 limit", async () => {
  const offsets: number[] = [];
  const client = new FestoClient("test", {
    fetcher: fetchMock((url) => {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return page([{ ...machine, id: id(offset + 1) }], offset, 3);
    }),
  });
  const records = [];
  for await (const items of client.pages("/incidents")) records.push(...items);
  assert.equal(records.length, 3);
  assert.deepEqual(offsets, [0, 1, 2]);
});
void test("空列表的 nullable items 与 total=0", async () => {
  const client = new FestoClient("test", {
    fetcher: fetchMock(() => Response.json({ items: null, total: 0, offset: 0 })),
  });
  assert.deepEqual(await client.machines(), []);
});
void test("读取早期故障下的新维修任务；跨页、跨日期边界、跳过信息日志", async () => {
  const paths: string[] = [];
  const events: unknown[] = [];
  const client = new FestoClient("test", {
    fetcher: fetchMock((url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test");
      assert.equal(url.origin, "https://api.festo.com");
      paths.push(url.pathname + url.search);
      if (url.pathname.endsWith("/machines")) return page([machine]);
      if (url.pathname.endsWith("/incidents")) {
        assert.equal(url.searchParams.has("from"), false);
        assert.equal(url.searchParams.has("to"), false);
        const offset = Number(url.searchParams.get("offset"));
        return offset === 0
          ? page(
              [
                {
                  id: id(10),
                  machineId: machine.id,
                  type: "Incident",
                  number: 42,
                  createdAt: "2020-01-01T00:00:00Z",
                },
              ],
              0,
              2,
            )
          : page([{ id: id(11), machineId: machine.id, type: "Information" }], 1, 2);
      }
      assert.ok(url.pathname.endsWith("/incidents/" + id(10)));
      return Response.json({
        id: id(10),
        machineId: machine.id,
        logNumber: 42,
        summary: "老故障",
        occurredAt: "2020-01-01T00:00:00Z",
        repairTasks: [
          { id: id(100), createdAt: "2026-08-31T15:59:59Z" },
          {
            id: id(101),
            createdAt: "2026-08-31T16:00:00Z",
            description: '中文, "说明"\n下一行',
            result: "Success",
          },
          { id: id(102), createdAt: "2026-09-08T15:59:59.999Z" },
          { id: id(103), createdAt: "2026-09-08T16:00:00Z" },
        ],
      });
    }),
  });
  const result = await collectRepairs(client, filters, (event) => events.push(event));
  assert.deepEqual(
    result.rows.map((r) => r.taskId),
    [id(102), id(101)],
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.rows[1].incidentNumber, "42");
  assert.equal(result.rows[1].machineName, machine.name);
  assert.equal(paths.length, 4);
  assert.ok(events.length > 0);
  const csv = toCsv(result.rows);
  assert.ok(csv.startsWith('\uFEFF"Machine name"'));
  assert.ok(csv.includes('"中文, ""说明""\n下一行"'));
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(csv.includes("2026-09-01 00:00:00"));
});
void test("401 不重试，403 与 429 显示等待时长", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const client = new FestoClient("test", {
      fetcher: fetchMock(() => {
        calls++;
        return new Response("", {
          status,
          headers: { "X-Retry-After": "120" },
        });
      }),
    });
    await assert.rejects(
      () => client.machines(),
      status === 401 ? /access token has expired/ : /120 seconds/,
    );
    assert.equal(calls, 1);
  }
});
void test("不完整分页、重复记录、总数变更都拒绝导出", async () => {
  for (const scenario of ["empty", "duplicate", "changed"]) {
    let calls = 0;
    const client = new FestoClient("test", {
      fetcher: fetchMock(() => {
        calls++;
        return calls === 1
          ? page([machine], 0, 2)
          : scenario === "empty"
            ? page([], 1, 2)
            : scenario === "duplicate"
              ? page([machine], 1, 2)
              : page([{ ...machine, id: id(2) }], 1, 3);
      }),
    });
    await assert.rejects(async () => {
      for await (const _page of client.pages("/incidents")) {
        /* consume all pages */
      }
    });
  }
});
void test("详情读取失败不返回部分结果", async () => {
  const client = new FestoClient("test", {
    fetcher: fetchMock((url) => {
      if (url.pathname.endsWith("/machines")) return page([machine]);
      if (url.pathname.endsWith("/incidents"))
        return page([
          { id: id(10), machineId: id(1), type: "Incident" },
          { id: id(11), machineId: id(1), type: "Incident" },
        ]);
      if (url.pathname.endsWith(id(10)))
        return Response.json({
          id: id(10),
          repairTasks: [{ id: id(100), createdAt: "2026-09-03T00:00:00Z" }],
        });
      return new Response("", { status: 500 });
    }),
  });
  await assert.rejects(() => collectRepairs(client, filters), /No results were exported/);
});
void test("日期无时区时失败，不默认为服务器时区", async () => {
  const client = new FestoClient("test", {
    fetcher: fetchMock((url) =>
      url.pathname.endsWith("/machines")
        ? page([machine])
        : url.pathname.endsWith("/incidents")
          ? page([{ id: id(10), machineId: id(1) }])
          : Response.json({
              id: id(10),
              repairTasks: [{ id: id(100), createdAt: "2026-09-01T00:00:00" }],
            }),
    ),
  });
  await assert.rejects(() => collectRepairs(client, filters), /invalid ID or creation time/);
});
void test("取消后不继续发出请求", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const client = new FestoClient("test", {
    signal: abort.signal,
    fetcher: fetchMock(() => {
      calls++;
      return page([]);
    }),
  });
  await assert.rejects(() => client.machines());
  assert.equal(calls, 0);
});
void test("CSV 公式防护、引号、中文和空值", () => {
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.equal(csvCell("  +1"), '"\'  +1"');
  assert.equal(csvCell("\t=1"), '"\'\t=1"');
  assert.equal(csvCell("普通中文"), '"普通中文"');
  assert.equal(csvCell(""), '""');
  assert.ok(toCsv([]).includes("Task created at (UTC+8)"));
});
void test("账号登录使用文档地址、表单编码、策略白名单", async () => {
  const result = await loginAccount(
    "api@example.com",
    "a&b+c",
    "b2c_1_apisignin_ropc",
    fetchMock((url, init) => {
      assert.equal(url.hostname, "smartenance.b2clogin.com");
      assert.equal(url.searchParams.get("p"), "b2c_1_apisignin_ropc");
      assert.ok(init?.body instanceof URLSearchParams);
      const body = init.body;
      assert.equal(body.get("password"), "a&b+c");
      assert.equal(body.get("grant_type"), "password");
      return Response.json({ access_token: "test", expires_in: 3600 });
    }),
  );
  assert.equal(result.token, "test");
  assert.equal(result.expiresIn, 3600);
  await assert.rejects(() => loginAccount("user", "pass", "https://bad"), /policy/);
});
void test("本地接口拒绝跨站请求、非本机访问、无效 JSON", async () => {
  const request = (url: string, origin: string) =>
    new Request(url, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
  assert.doesNotThrow(() =>
    checkRequest(request("http://localhost:3000/api/connect", "http://localhost:3000")),
  );
  assert.throws(() =>
    checkRequest(request("http://localhost:3000/api/connect", "https://evil.com")),
  );
  assert.throws(() =>
    checkRequest(request("http://example.com/api/connect", "http://example.com")),
  );
  assert.deepEqual(
    await readBody(request("http://localhost:3000/api/connect", "http://localhost:3000")),
    {},
  );
});

void test("使用运行环境支持的 manual 模式，禁止携带凭证跟随跳转", async () => {
  let apiCalls = 0;
  const client = new FestoClient("test", {
    fetcher: fetchMock((_url, init) => {
      apiCalls++;
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/" },
      });
    }),
  });
  await assert.rejects(() => client.machines(), /unexpected redirect/);
  assert.equal(apiCalls, 1);
  let loginCalls = 0;
  await assert.rejects(
    () =>
      loginAccount(
        "test-user",
        "test-password",
        "b2c_1_apisignin_ropc",
        fetchMock((_url, init) => {
          loginCalls++;
          assert.equal(init?.redirect, "manual");
          return new Response(null, {
            status: 307,
            headers: { Location: "https://example.invalid/" },
          });
        }),
      ),
    /unexpected redirect/,
  );
  assert.equal(loginCalls, 1);
});

void test("加载并全选超过 200 和 500 台设备，使用官方 limit=-1", async () => {
  const machines = Array.from({ length: 751 }, (_, i) => ({ ...machine, id: id(i + 1) }));
  let calls = 0;
  const client = new FestoClient("test", {
    fetcher: fetchMock((url) => {
      calls++;
      assert.equal(url.pathname, "/apps/smartenance/v1/machines");
      assert.equal(url.searchParams.get("limit"), "-1");
      assert.equal(url.searchParams.has("offset"), false);
      return page(machines);
    }),
  });
  const result = await client.machines();
  assert.equal(result.length, 751);
  assert.equal(result[750].id, id(751));
  assert.equal(calls, 1);
  assert.equal(
    validateFilters({ ...filters, machineIds: result.map((m) => m.id) }).machineIds.length,
    751,
  );
});

void test("全部设备响应被截断或存在重复项时，不静默返回前 200 台", async () => {
  for (const items of [
    Array.from({ length: 200 }, (_, i) => ({ ...machine, id: id(i + 1) })),
    [machine, machine],
  ]) {
    const client = new FestoClient("test", {
      fetcher: fetchMock(() => page(items, 0, items.length === 200 ? 751 : 2)),
    });
    await assert.rejects(() => client.machines(), /complete machine list|duplicate/);
  }
});
