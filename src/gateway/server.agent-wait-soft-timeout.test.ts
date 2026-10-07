import { afterEach, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setGatewayDedupeEntry } from "./agent-turn/agent-job.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

let cleanupGateway: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanupGateway?.();
  cleanupGateway = undefined;
});

it(
  "agent.wait over a real Gateway client keeps a completion over later soft timeouts",
  { timeout: 120_000 },
  async () => {
    const token = "synthetic-agent-wait-soft-timeout-token";
    const state = await createOpenClawTestState({
      label: "agent-wait-soft-timeout",
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    let context: GatewayRequestContext | undefined;
    const kernel = await import("./server-kernel-request-runtime.js");
    const prepare = kernel.prepareGatewayKernelRequestRuntime;
    const startupSpy = vi
      .spyOn(kernel, "prepareGatewayKernelRequestRuntime")
      .mockImplementation(async (params) => {
        const result = await prepare(params);
        context = result.gatewayRequestContext;
        return result;
      });
    cleanupGateway = async () => {
      startupSpy.mockRestore();
      await state.cleanup();
    };

    const gateway = await startGatewayWithClient({
      cfg: {
        agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
      },
      configPath: state.configPath,
      token,
    });
    cleanupGateway = async () => {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
      await state.cleanup();
    };
    startupSpy.mockRestore();
    await gateway.server.startupSettled;
    if (!context) {
      throw new Error("Missing live Gateway request context");
    }

    const results: Record<string, unknown> = {};
    for (const timeoutPhase of ["queue", "gateway_draining"] as const) {
      const runId = `rpc-completed-then-${timeoutPhase}-timeout`;
      // Seed the running server's own dedupe store in observation order.
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: Date.now(),
          ok: true,
          payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
        },
      });
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload: { runId, status: "timeout", endedAt: 300, timeoutPhase },
        },
      });

      results[timeoutPhase] = await gateway.client.request("agent.wait", {
        runId,
        timeoutMs: 5_000,
      });
      console.log("AGENT_WAIT_RPC", timeoutPhase, JSON.stringify(results[timeoutPhase]));
    }
    expect(results).toMatchObject({
      queue: { status: "ok", endedAt: 200 },
      gateway_draining: { status: "ok", endedAt: 200 },
    });
  },
);
