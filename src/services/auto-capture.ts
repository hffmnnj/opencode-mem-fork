import type { PluginInput } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager, type UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { truncateToMaxBytes, utf8ByteLength } from "../utils/context-limit.js";
import { stripPrivateContent, isFullyPrivate } from "./privacy.js";
import { isInjectedPart } from "./injected-prompt-filter.js";
import {
  DURABLE_CAPTURE_VERSION,
  buildDurableCaptureSystemPrompt,
  captureSummarySchema,
  validateCaptureSummary,
  type CaptureSource,
} from "./memory-quality.js";
import { z } from "zod";
const RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES = 131072;
const CONTEXT_TRUNCATION_MARKER = "\n[... truncated to autoCaptureMaxContextBytes ...]\n";
const SUMMARY_REQUEST_OVERHEAD_BYTES = 1024;
const SUMMARY_OUTPUT_RESERVE_BYTES = 16384;
const SUMMARY_ANALYSIS_SUFFIX =
  "Extract only reusable knowledge supported by the evidence sources above.";

// Serializes captures across sessions. Replacing the old module-wide boolean
// (which silently dropped any session whose idle fired while another capture
// was in flight — a finished session then never got summarized), jobs now
// queue behind the running one. The chain itself never rejects so one failed
// job cannot poison the next; each caller still observes its own job's
// actual outcome.
let captureChain: Promise<void> = Promise.resolve();

export interface PerformAutoCaptureOptions {
  /**
   * Skip this job if it has not started yet once the signal aborts (e.g. the
   * plugin is disposing). In-flight captures are NOT cancelled: model
   * requests were never cancellable and keep their original semantics.
   */
  signal?: AbortSignal;
}

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  options: PerformAutoCaptureOptions = {}
): Promise<void> {
  const run = async () => {
    if (options.signal?.aborted) return;
    await runAutoCapture(ctx, sessionID, directory);
  };

  const next = captureChain.then(run, run);
  // Keep the chain alive regardless of this job's outcome; `next` still
  // rejects to the caller when their own job failed.
  captureChain = next.catch(() => {});
  return next;
}

/**
 * Wait until every capture job that has already been enqueued finishes.
 * Used by plugin dispose so `memoryClient.close()` does not race an
 * in-flight capture that was intentionally left uncancellable.
 */
export function awaitCaptureDrain(): Promise<void> {
  return captureChain;
}

async function runAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string
): Promise<void> {
  const prompts = await userPromptManager.getUncapturedPromptsForSession(sessionID);
  if (prompts.length === 0) {
    return;
  }

  if (!CONFIG.autoCaptureProviderStatus.ready) {
    return;
  }

  const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
  for (const prompt of prompts) {
    await capturePrompt(ctx, sessionID, directory, prompt, maxRetries);
  }
}

async function capturePrompt(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  prompt: UserPrompt,
  maxRetries: number
): Promise<void> {
  let claimedPromptId: string | null = null;
  let attempt = prompt.capture_attempts || 0;

  try {
    if (!(await userPromptManager.claimPrompt(prompt.id))) {
      return;
    }
    claimedPromptId = prompt.id;

    while (attempt < maxRetries) {
      attempt++;
      try {
        if (!ctx.client) {
          throw new Error("Client not available");
        }

        const response = await ctx.client.session.messages({
          path: { id: sessionID },
        });

        if (!response.data) {
          return;
        }

        const messages = response.data;
        const aiMessages = getAIResponseMessages(messages, prompt.messageId);
        if (aiMessages === null) {
          return;
        }
        if (aiMessages.length === 0) {
          return;
        }

        const assistantSources = extractAIContent(aiMessages);
        if (
          assistantSources.length === 0 &&
          !aiMessages.some(
            (message) =>
              message.info?.role === "assistant" &&
              message.info?.summary !== true &&
              message.info?.mode !== "compaction" &&
              Array.isArray(message.parts) &&
              message.parts.some((part: any) => part.type === "tool")
          )
        ) {
          return;
        }

        const tags = getTags(directory);
        const userText = stripPrivateContent(prompt.content);
        const sources: CaptureSource[] = [
          ...(!isFullyPrivate(userText)
            ? [{ messageId: prompt.messageId, role: "user" as const, text: userText }]
            : []),
          ...assistantSources,
        ];
        const context = buildMarkdownContext(sources, getAutoCaptureMarkdownBudget());

        let capture: ReturnType<typeof validateCaptureSummary>;
        try {
          const result = await generateSummary(ctx, context, sessionID, userText, prompt);
          // Redaction placeholders are not evidence, nor may excerpts bridge them.
          const eligibleSources = sources.flatMap((source) =>
            source.text
              .split("[REDACTED]")
              .filter((text) => text.trim())
              .map((text) => ({ ...source, text }))
          );
          capture = validateCaptureSummary(result, eligibleSources);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Summary generation failed: ${message}`, { cause: error });
        }

        const { summary: summaryResult, evidence } = capture;
        if (summaryResult.type === "skip") {
          log("Auto-capture skipped", {
            promptId: prompt.id,
            sessionID,
            type: summaryResult.type,
          });
          await userPromptManager.deletePrompt(prompt.id);
          claimedPromptId = null;
          return;
        }

        const observedAt = latestMessageTime(aiMessages);
        const root = summaryResult.codeAnchors?.length
          ? (await import("./tags.js")).getGitTopLevel(directory)
          : null;
        const codeAnchors = root
          ? await (
              await import("./code-anchors.js")
            ).validateCodeAnchors(
              root,
              summaryResult.codeAnchors ?? [],
              sources.flatMap((source) => source.text.split("[REDACTED]"))
            )
          : [];

        const summaryWithTags =
          summaryResult.tags && summaryResult.tags.length > 0
            ? `${summaryResult.summary}\n\nTags: ${summaryResult.tags.join(", ")}`
            : summaryResult.summary;

        const result = await memoryClient.addMemory(summaryWithTags, tags.project.tag, {
          source: "auto-capture",
          type: summaryResult.type,
          tags: summaryResult.tags,
          sessionID,
          promptId: prompt.id,
          captureVersion: DURABLE_CAPTURE_VERSION,
          memoryKind: summaryResult.type,
          sourceMessageId: prompt.messageId,
          evidence,
          captureTimestamp: Date.now(),
          ...(observedAt !== null ? { observedAt } : {}),
          ...(codeAnchors.length ? { codeAnchors } : {}),
          displayName: tags.project.displayName,
          userName: tags.project.userName,
          userEmail: tags.project.userEmail,
          projectPath: tags.project.projectPath,
          projectName: tags.project.projectName,
          gitRepoUrl: tags.project.gitRepoUrl,
        });

        if (result.success) {
          await userPromptManager.linkMemoryToPrompt(prompt.id, result.id);
          await userPromptManager.markAsCaptured(prompt.id);
          claimedPromptId = null;
          log("Auto-capture memory persisted", {
            promptId: prompt.id,
            sessionID,
            memoryId: result.id,
          });

          if (CONFIG.showAutoCaptureToasts) {
            await ctx.client?.tui
              .showToast({
                body: {
                  title: "Memory Captured",
                  message: "Project memory saved from conversation",
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
          return;
        } else {
          throw new Error(`Memory persistence failed: ${result.error || "database write failed"}`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        await userPromptManager.recordFailedAttempt(prompt.id);

        if (attempt < maxRetries) {
          log(`Auto-capture warning (attempt ${attempt}/${maxRetries})`, { error: errMsg });
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
          );
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log(`Auto-capture final error after ${attempt} attempts`, { error: errMsg });
    if (CONFIG.showErrorToasts) {
      const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
      await ctx.client?.tui
        .showToast({
          body: {
            title: "Auto Capture Failed",
            message: shortReason,
            variant: "error",
            duration: 5000,
          },
        })
        .catch(() => {});
    }
  } finally {
    if (claimedPromptId !== null) {
      try {
        await userPromptManager.releaseClaim(claimedPromptId);
      } catch (releaseErr) {
        log(
          `Failed to release captured=2 claim for prompt ${claimedPromptId}: ${
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
          }`
        );
      }
    }
  }
}

function latestMessageTime(messages: any[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.info?.role !== "assistant") continue;
    const completed = message.info?.time?.completed;
    const created = message.info?.time?.created;
    const time =
      typeof completed === "number" && Number.isFinite(completed) && completed > 0
        ? completed
        : created;
    if (typeof time === "number" && Number.isFinite(time) && time > 0) {
      latest = latest === null ? time : Math.max(latest, time);
    }
  }
  return latest;
}

function getAIResponseMessages(messages: any[], promptMessageId: string): any[] | null {
  const promptIndex = messages.findIndex((m: any) => m.info?.id === promptMessageId);
  if (promptIndex === -1) return null;

  const responseMessages: any[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.info?.role === "user") break;
    responseMessages.push(message);
  }
  return responseMessages;
}

function extractAIContent(messages: any[]): CaptureSource[] {
  const sources: CaptureSource[] = [];
  for (const msg of messages) {
    if (
      msg.info?.role !== "assistant" ||
      typeof msg.info.id !== "string" ||
      !msg.info.id ||
      msg.info.summary === true ||
      msg.info.mode === "compaction" ||
      !Array.isArray(msg.parts)
    )
      continue;
    const parts = msg.parts.filter(
      (part: any) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.ignored !== true &&
        !isInjectedPart(part)
    );
    // Redact after joining parts so private tags spanning parts remain private.
    const text = stripPrivateContent(parts.map((part: any) => part.text).join("\n"));
    if (!isFullyPrivate(text)) sources.push({ messageId: msg.info.id, role: "assistant", text });
  }
  return sources;
}

export function getAutoCaptureMarkdownBudget(
  totalRequestBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): number {
  const requestReserve = Math.min(24576, Math.floor(totalRequestBytes * 0.25));
  return Math.max(4096, totalRequestBytes - requestReserve);
}

export function buildBoundedSummaryPrompt(
  context: string,
  systemPrompt: string,
  schema: unknown,
  totalRequestBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): string {
  const schemaBytes = utf8ByteLength(JSON.stringify(schema));
  const outputReserve = Math.min(
    SUMMARY_OUTPUT_RESERVE_BYTES,
    Math.floor(totalRequestBytes * 0.125)
  );
  const userBudget = Math.max(
    0,
    totalRequestBytes -
      utf8ByteLength(systemPrompt) -
      schemaBytes -
      outputReserve -
      SUMMARY_REQUEST_OVERHEAD_BYTES
  );
  return truncateToMaxBytes(
    `${context}\n\n${SUMMARY_ANALYSIS_SUFFIX}`,
    userBudget,
    CONTEXT_TRUNCATION_MARKER
  );
}

/** Build auto-capture markdown context, capped to autoCaptureMaxContextBytes (UTF-8). */
export function buildMarkdownContext(
  sources: readonly CaptureSource[],
  maxContextBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): string {
  const blocks: string[] = [];
  let remaining = Math.max(0, maxContextBytes);
  const user = sources.find((source) => source.role === "user");
  const assistants = sources.filter((source) => source.role === "assistant");
  const addSource = (source: CaptureSource, budget: number) => {
    const header = `## Evidence source ${source.role} messageId=${JSON.stringify(source.messageId)}\n`;
    const overhead = utf8ByteLength(header) + 2;
    if (budget <= overhead) return;
    const body = truncateToMaxBytes(source.text, budget - overhead, CONTEXT_TRUNCATION_MARKER);
    const block = `${header}${body}\n\n`;
    remaining -= utf8ByteLength(block);
    blocks.push(block);
  };
  if (user) {
    const reserve = assistants.length > 0 ? Math.min(4096, Math.floor(remaining * 0.25)) : 0;
    addSource(user, remaining - reserve);
  }
  const assistantBlocks: string[] = [];
  for (let i = assistants.length - 1; i >= 0; i--) {
    const before = blocks.length;
    addSource(assistants[i]!, remaining);
    if (blocks.length === before) break;
    assistantBlocks.unshift(blocks.pop()!);
  }
  return [...blocks, ...assistantBlocks].join("");
}

async function generateSummary(
  ctx: PluginInput,
  context: string,
  sessionID: string,
  userPrompt: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<unknown> {
  let opencodeProviderError: unknown;

  // Opencode provider path (when opencodeProvider + opencodeModel configured)
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    try {
      if (CONFIG.memoryModel) {
        log("opencodeProvider takes precedence over memoryModel for auto-capture");
      }

      const { ensureProviderConnected, getV2Client, generateStructuredOutput } =
        await loadOpencodeProvider();

      // "inherit" resolves to the model opencode used for the captured prompt
      // (recorded by the chat.params hook). Without a concrete model id, the
      // provider path cannot issue a structured-output request.
      let providerID = CONFIG.opencodeProvider;
      let modelID = CONFIG.opencodeModel;
      if (modelID === "inherit") {
        if (!prompt?.providerId || !prompt?.modelId) {
          throw new Error(
            "opencode-mem: opencodeModel is 'inherit' but no session model was recorded for this prompt"
          );
        }
        providerID = prompt.providerId;
        modelID = prompt.modelId;
      }

      // One refresh-on-miss before failing: user-config providers register
      // seconds after plugin setup, so the init snapshot may lag the host.
      if (!(await ensureProviderConnected(providerID))) {
        throw new Error(
          `opencode provider '${providerID}' is not connected. Check your opencode provider configuration.`
        );
      }

      const v2Client = getV2Client();
      if (!v2Client) {
        throw new Error(
          "opencode-mem: v2 client not initialized; cannot perform structured-output capture"
        );
      }

      const { detectLanguage, getLanguageName } = await import("./language-detector.js");
      const targetLang =
        CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
          ? detectLanguage(userPrompt)
          : CONFIG.autoCaptureLanguage;
      const langName = getLanguageName(targetLang);

      const systemPrompt = buildDurableCaptureSystemPrompt(langName);
      const schema = captureSummarySchema;
      const aiPrompt = buildBoundedSummaryPrompt(context, systemPrompt, z.toJSONSchema(schema));

      const result = await generateStructuredOutput({
        client: v2Client,
        providerID,
        modelID,
        ...(CONFIG.opencodeVariant ? { variant: CONFIG.opencodeVariant } : {}),
        systemPrompt,
        userPrompt: aiPrompt,
        schema,
      });

      return result;
    } catch (e) {
      opencodeProviderError = e;
      log("auto-capture: opencode provider failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  // Existing manual config path
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    if (opencodeProviderError) {
      throw opencodeProviderError;
    }
    throw new Error("External API not configured for auto-capture");
  }

  // Opencode provider failed but a manual fallback is configured — surface a
  // non-blocking warning so the user knows their primary provider is broken.
  if (opencodeProviderError && CONFIG.showErrorToasts) {
    const errMsg =
      opencodeProviderError instanceof Error
        ? opencodeProviderError.message
        : String(opencodeProviderError);
    const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
    ctx.client?.tui
      .showToast({
        body: {
          title: "Using fallback provider",
          message: `OpenCode provider failed (${shortReason}); using configured fallback.`,
          variant: "warning",
          duration: 5000,
        },
      })
      .catch(() => {});
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
  const { detectLanguage, getLanguageName } = await import("./language-detector.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(userPrompt)
      : CONFIG.autoCaptureLanguage;

  const langName = getLanguageName(targetLang);

  const systemPrompt = buildDurableCaptureSystemPrompt(langName);

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Save reusable technical knowledge with source evidence",
      parameters: z.toJSONSchema(captureSummarySchema),
    },
  };
  const aiPrompt = buildBoundedSummaryPrompt(context, systemPrompt, toolSchema);
  const captureSessionID = `auto-capture-${prompt?.id ?? sessionID}-${randomUUID()}`;

  const result = await provider.executeToolCall(
    systemPrompt,
    aiPrompt,
    toolSchema,
    captureSessionID
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return result.data;
}
