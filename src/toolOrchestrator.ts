/**
 * Tool-Aware Streaming Orchestrator
 *
 * The critical problem:
 *   User: "Open trainer docs and— actually wait— search kubeflow instead"
 *
 *   1. Model emits tool_call for "open trainer docs"
 *   2. Tool starts executing
 *   3. User interrupts
 *   4. We must: cancel the in-flight tool, NOT send its result,
 *      and handle the new user intent cleanly.
 *
 * This module handles the hardest voice-agent scenario:
 * cancelling in-flight tool execution on barge-in.
 */

import { InterruptHandler, CancellableOperation } from "./interruptHandler.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<unknown>;
}

export interface ToolCallResult {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  cancelled: boolean;
  durationMs: number;
}

export class ToolOrchestrator {
  private tools: Map<string, ToolDefinition> = new Map();
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private callCounter = 0;

  constructor(private interruptHandler: InterruptHandler) {}

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Returns tool declarations in the format the Live API expects
   * for function calling configuration.
   */
  getToolDeclarations(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Execute a tool call with full cancellation support.
   *
   * The AbortController is registered with the InterruptHandler,
   * so if the user barges in mid-execution, the tool is cancelled.
   *
   * @param callId  If provided, used as the key for selective cancellation
   *                via cancelByIds(). The Live API assigns IDs to each
   *                FunctionCall — passing call.id here allows
   *                toolCallCancellation to cancel specific tools.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    callId?: string
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolName,
        args,
        result: { error: `Unknown tool: ${toolName}` },
        cancelled: false,
        durationMs: 0,
      };
    }

    const id = callId ?? `tool-${++this.callCounter}-${toolName}`;
    const abortController = new AbortController();
    this.activeAbortControllers.set(id, abortController);

    // Register with interrupt handler for barge-in cancellation
    const cancellable: CancellableOperation = {
      id,
      cancel: () => abortController.abort(),
    };
    this.interruptHandler.register(cancellable);

    const startTime = Date.now();

    try {
      const result = await tool.execute(args, abortController.signal);
      return {
        toolName,
        args,
        result,
        cancelled: false,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const cancelled =
        err instanceof Error && err.name === "AbortError";
      return {
        toolName,
        args,
        result: cancelled ? { cancelled: true } : { error: String(err) },
        cancelled,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.activeAbortControllers.delete(id);
      this.interruptHandler.unregister(id);
    }
  }

  /**
   * Cancel specific tool calls by their IDs.
   *
   * Used by toolCallCancellation — the server sends the exact IDs of
   * tools to cancel, which may be a subset of active tools.
   * cancelAll() is still used for barge-in (interrupt kills everything).
   */
  cancelByIds(ids: string[]): void {
    for (const id of ids) {
      const controller = this.activeAbortControllers.get(id);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(id);
        this.interruptHandler.unregister(id);
      }
    }
  }

  cancelAll(): void {
    for (const [, controller] of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
  }

  get activeCallCount(): number {
    return this.activeAbortControllers.size;
  }
}
