import { ProviderAdapter } from '../types';
import { OpenAICompatAdapter } from './openai-compat';
import { GoogleAdapter } from './google';
import { NvidiaAdapter } from './nvidia';
import { GroqAdapter } from './groq';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/**
 * Map of provider names to their adapter instances.
 *
 * Adapters are lazily instantiated the first time they are requested so that
 * unused providers do not consume memory.
 */
const registry = new Map<string, () => ProviderAdapter>();

// Register adapters lazily
function register(name: string, factory: () => ProviderAdapter): void {
  registry.set(name, factory);
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

register('openai', () => new OpenAICompatAdapter('openai', 'https://api.openai.com/v1'));
register('google', () => new GoogleAdapter());
register('nvidia', () => new NvidiaAdapter());
register('groq', () => new GroqAdapter());

// Also register aliases
register('gemini', () => new GoogleAdapter());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the adapter instance for a given provider name.
 *
 * @param name - Provider name (e.g. `'openai'`, `'google'`, `'nvidia'`, `'groq'`).
 * @returns The provider adapter instance.
 * @throws If the provider is not registered.
 */
export function getProvider(name: string): ProviderAdapter {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Unknown provider: "${name}". Available: ${listProviders().join(', ')}`);
  }
  return factory();
}

/**
 * Return a list of all registered provider names.
 */
export function listProviders(): string[] {
  return Array.from(registry.keys());
}

/**
 * Register a custom provider adapter at runtime.
 *
 * @param name - Provider name.
 * @param adapter - An instance of ProviderAdapter.
 */
export function registerProvider(name: string, adapter: ProviderAdapter): void {
  registry.set(name, () => adapter);
}

/**
 * Check whether a provider is registered.
 */
export function hasProvider(name: string): boolean {
  return registry.has(name);
}

/**
 * Return all provider adapters as a map of name -> adapter.
 * Each call creates fresh instances.
 */
export function getAllProviders(): Map<string, ProviderAdapter> {
  const result = new Map<string, ProviderAdapter>();
  for (const [name, factory] of registry) {
    result.set(name, factory());
  }
  return result;
}

// Re-export adapter classes for convenience
export { OpenAICompatAdapter } from './openai-compat';
export { GoogleAdapter } from './google';
export { NvidiaAdapter } from './nvidia';
export { GroqAdapter } from './groq';