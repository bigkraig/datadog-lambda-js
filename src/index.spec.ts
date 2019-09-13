import http from "http";
import nock from "nock";

import { datadog, getTraceHeaders, sendDistributionMetric, TraceHeaders } from "./index";
import { LogLevel, setLogLevel } from "./utils";
import tracer, { Span } from "dd-trace";

describe("datadog", () => {
  let traceId: string | undefined;
  let parentId: string | undefined;
  let sampled: string | undefined;
  let oldEnv: typeof process.env;

  const handler = (ev: any, context: any, callback: any) => {
    // Mocks out the call
    const req = http.get("http://www.example.com");
    traceId = req.getHeader("x-datadog-trace-id") as string;
    parentId = req.getHeader("x-datadog-parent-id") as string;
    sampled = req.getHeader("x-datadog-sampling-priority") as string;
    callback(null, "Result");
  };
  beforeEach(() => {
    traceId = undefined;
    parentId = undefined;
    sampled = undefined;
    setLogLevel(LogLevel.NONE);
    oldEnv = process.env;
    process.env = { ...oldEnv };
    nock.cleanAll();
  });
  afterEach(() => {
    process.env = oldEnv;
  });

  it("patches http request when autoPatch enabled", async () => {
    nock("http://www.example.com")
      .get("/")
      .reply(200, {});
    const wrapped = datadog(handler);
    await wrapped(
      {
        headers: {
          "x-datadog-parent-id": "9101112",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "123456",
        },
      },
      {} as any,
      async () => {
        return true;
      },
    );

    expect(traceId).toEqual("123456");
    expect(parentId).toEqual("9101112");
    expect(sampled).toEqual("2");
  });
  it("doesn't patch http requests when autoPatch is disabled", async () => {
    nock("http://www.example.com")
      .get("/")
      .reply(200, {});
    const wrapped = datadog(handler, { autoPatchHTTP: false });
    await wrapped(
      {
        headers: {
          "x-datadog-parent-id": "9101112",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "123456",
        },
      },
      {} as any,
      async () => {
        return true;
      },
    );

    expect(traceId).toBeUndefined();
    expect(parentId).toBeUndefined();
    expect(sampled).toBeUndefined();
  });

  it("reads API key from the environment for metrics", async () => {
    const apiKey = "123456";
    const apiKeyVar = "DD_API_KEY";
    process.env[apiKeyVar] = apiKey;

    nock("https://api.datadoghq.com")
      .post(`/api/v1/distribution_points?api_key=${apiKey}`, (request: any) => request.series[0].metric === "my-dist")
      .reply(200, {});

    const wrapped = datadog(async () => {
      sendDistributionMetric("my-dist", 100, "first-tag", "second-tag");
      return "";
    });
    await wrapped({}, {} as any, () => {});

    expect(nock.isDone()).toBeTruthy();
  });

  it("prefers API key from the config object over the environment variable ", async () => {
    const envApiKey = "123456";
    const apiKeyVar = "DD_API_KEY";
    process.env[apiKeyVar] = envApiKey;
    const apiKey = "101112";

    nock("https://api.datadoghq.com")
      .post(`/api/v1/distribution_points?api_key=${apiKey}`, (request: any) => request.series[0].metric === "my-dist")
      .reply(200, {});

    const wrapped = datadog(
      async () => {
        sendDistributionMetric("my-dist", 100, "first-tag", "second-tag");
        return "";
      },
      { apiKey },
    );
    await wrapped({}, {} as any, () => {});

    expect(nock.isDone()).toBeTruthy();
  });

  it("reads site keys from the environment", async () => {
    const site = "datadoghq.com";
    const siteEnvVar = "DD_SITE";
    const apiKey = "12345";
    process.env[siteEnvVar] = site;

    nock("https://api.datadoghq.com")
      .post(`/api/v1/distribution_points?api_key=${apiKey}`, (request: any) => request.series[0].metric === "my-dist")
      .reply(200, {});

    const wrapped = datadog(
      async () => {
        sendDistributionMetric("my-dist", 100, "first-tag", "second-tag");
        return "";
      },
      { apiKey },
    );
    await wrapped({}, {} as any, () => {});

    expect(nock.isDone()).toBeTruthy();
  });

  it("makes the current trace headers available", async () => {
    let traceHeaders: Partial<TraceHeaders> = {};
    const event = {
      headers: {
        "x-datadog-parent-id": "9101112",
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "123456",
      },
    };

    const wrapped = datadog(async () => {
      traceHeaders = getTraceHeaders();
      return "";
    });
    await wrapped(event, {} as any, () => {});
    expect(traceHeaders).toEqual({
      "x-datadog-parent-id": "9101112",
      "x-datadog-sampling-priority": "2",
      "x-datadog-trace-id": "123456",
    });
  });

  it("returns a value from an async handler", async () => {
    const localHandler = async (ev: any, context: any, callback: any) => {
      return 312;
    };
    const wrapped = datadog(localHandler);
    const value = await wrapped({}, {} as any, async () => {});

    expect(value).toEqual(312);
  });
  it("returns a value from a callback handler", async () => {
    const localHandler = function(ev: any, context: any, callback: any) {
      callback(null, 312);
    };
    const wrapped = datadog(localHandler);
    const value = await wrapped({}, {} as any, async () => {});

    expect(value).toEqual(312);
  });

  it("will do an early timeout when tracing is enabled", async () => {
    const localHandler = function(ev: any, context: any, callback: any) {}; // Never completes
    const wrapped = datadog(localHandler);
    const promise = wrapped({}, { getRemainingTimeInMillis: () => 100 } as any, async () => {});
    await expect(promise).resolves;
  });
});
