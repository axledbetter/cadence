// src/adapters/sdk-loader.ts
//
// Lazy-load LLM SDKs via dynamic import so the package doesn't pay the boot
// cost (or install footprint) for providers the user isn't using. The four
// LLM SDKs together account for ~26 MB of node_modules; users with only one
// API key need only one of them.
//
// On a missing SDK, throw a `GuardrailError` with the exact `npm install`
// command — same UX as a missing API key.

import { GuardrailError } from '../core/errors.ts';

import type AnthropicNS from '@anthropic-ai/sdk';
import type OpenAINS from 'openai';

import type { GoogleGenerativeAI as GoogleGenAINS } from '@google/generative-ai';

type AnthropicCtor = typeof AnthropicNS;
type OpenAICtor = typeof OpenAINS;
type GoogleGenerativeAICtor = typeof GoogleGenAINS;

/**
 * Minimal structural shape for @aws-sdk/client-bedrock-runtime. We type by
 * shape (not by the SDK's exported types) so the package can be optional —
 * users who don't use bedrock never need it installed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BedrockRuntimeModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CohereModule = any;

function isModuleNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function missingSdkError(pkg: string, provider: string): GuardrailError {
  return new GuardrailError(
    `${pkg} not installed — run: npm install ${pkg}`,
    { code: 'auth', provider },
  );
}

export async function loadAnthropic(): Promise<AnthropicCtor> {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return (mod.default ?? mod) as AnthropicCtor;
  } catch (err) {
    if (isModuleNotFound(err)) throw missingSdkError('@anthropic-ai/sdk', 'claude');
    throw err;
  }
}

export async function loadOpenAI(): Promise<OpenAICtor> {
  try {
    const mod = await import('openai');
    return (mod.default ?? mod) as OpenAICtor;
  } catch (err) {
    if (isModuleNotFound(err)) throw missingSdkError('openai', 'openai');
    throw err;
  }
}

export async function loadGoogleGenerativeAI(): Promise<GoogleGenerativeAICtor> {
  try {
    const mod = await import('@google/generative-ai');
    return (mod as { GoogleGenerativeAI: GoogleGenerativeAICtor }).GoogleGenerativeAI;
  } catch (err) {
    if (isModuleNotFound(err)) throw missingSdkError('@google/generative-ai', 'gemini');
    throw err;
  }
}

export async function loadBedrockRuntime(): Promise<BedrockRuntimeModule> {
  try {
    const mod = await import('@aws-sdk/client-bedrock-runtime');
    return mod;
  } catch (err) {
    if (isModuleNotFound(err)) throw missingSdkError('@aws-sdk/client-bedrock-runtime', 'bedrock');
    throw err;
  }
}

export async function loadCohere(): Promise<CohereModule> {
  try {
    const mod = await import('cohere-ai');
    // cohere-ai v7+ exports `CohereClient` as named export
    return (mod as { CohereClient?: unknown }).CohereClient ?? (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    if (isModuleNotFound(err)) throw missingSdkError('cohere-ai', 'cohere');
    throw err;
  }
}

/**
 * Quick non-throwing check — used by `doctor` to report install state.
 */
export async function isSdkInstalled(pkg: string): Promise<boolean> {
  try {
    await import(pkg);
    return true;
  } catch (err) {
    if (isModuleNotFound(err)) return false;
    // Other errors (e.g., the SDK itself failed to load) — count as installed
    // but broken; doctor will surface that separately if needed.
    return true;
  }
}
